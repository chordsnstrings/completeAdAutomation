# Meta Video Creative Pipeline — Engineering Dossier
**Scope:** getting an AI-generated video file from disk into a live, delivering Meta ad (Facebook + Instagram), fully programmatically.
**Compiled:** 2026-09-02. **Baseline API version: `v26.0`.**
**Adversarially fact-checked 2026-09-02** against Meta primary sources — see the [Fact-check log](#fact-check-log) at the bottom for per-claim verdicts. Inline corrections are marked *"Fact-check"*.

> Every non-obvious claim below carries a source URL. Anything I could not confirm against a primary source is explicitly marked **UNVERIFIED**. Meta's Business Help Center pages (`facebook.com/business/help/...`) are client-rendered and could not be scraped; where a fact is only available there it is marked accordingly.

---

## 0. Version baseline and moving parts

| Fact | Value | Source |
|---|---|---|
| Latest Graph API / Marketing API version | **v26.0**, released **2026-07-29** | https://developers.facebook.com/docs/graph-api/changelog |
| v25.0 released | 2026-02-18 (available until 2028-07-29) | same |
| v24.0 released | 2025-10-08 (available until 2028-02-18) | same |
| Base host for ALL uploads | `https://graph.facebook.com/v26.0/...` | https://developers.facebook.com/docs/video-api/getting-started/ |

**Gotcha #1 (host):** the old advice to POST video to `graph-video.facebook.com` is dead. Meta's Video API getting-started page now states: *"Use the `graph.facebook.com` host for API requests when uploading videos to Meta servers."* (https://developers.facebook.com/docs/video-api/getting-started/). Legacy SDKs and Stack Overflow answers still point at `graph-video.*`; hard-code `graph.facebook.com` and pin the version.

### v26.0 changes that break creative code
From https://developers.facebook.com/docs/graph-api/changelog/version26.0/ :
- *"The Instagram Explore Feed placement is no longer available. Delivery shifts to other eligible placements, and requests that explicitly specify Explore return an error."*
- *"The `story` value in `messenger_positions` is silently removed for versioned v26.0 or later calls and no longer appears in effective placements."* (silent removal — your effective placement set will differ from what you sent)
- *"Poll components are no longer supported when creating or updating ads and creatives."* The `poll_spec` field and the `poll` type under `interactive_components_spec` become unavailable. Affected edges per the changelog: `POST /{ad-account-id}/adcreatives`, `POST /{ad-account-id}/ads`, `POST /{ad-id}`, and **`GET`** `/{ad-account-id}/generatepreviews`. *(Fact-check 2026-09-02: generatepreviews is a **GET** edge, not POST as originally written here.)*
- Shops ads creatives auto-default to `destination_spec.destination_type = WEBSITE_AND_SHOP`. **Opt out by explicitly setting `destination_type = WEBSITE_AND_SHOP_OPT_OUT`** (fact-check addition; the changelog names this escape hatch and the original draft omitted it).

---

## 1. Uploading the video — `POST /act_{ad_account_id}/advideos`

Reference: https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/
(A complete mirror of the same reference table, including the response struct and error codes, is at https://www.withone.ai/knowledge/meta/conn_mod_def::GKRjtRsW_dY::-DzRZc5aRdCUjqK0XPw4fQ )

### 1.1 Three ways in

| Method | How | When to use |
|---|---|---|
| **Simple multipart** | `-F "source=@/path/video.mp4"` | Small files; single request; simplest. |
| **Pull-from-URL** | `-F "file_url=https://cdn.example/video.mp4"` | Video already on a public CDN. Meta fetches it server-side. Failure surfaces as **error 389 "Unable to fetch video file from URL."** |
| **Chunked / resumable** | `upload_phase=start|transfer|finish|cancel` | Large files, flaky networks, resumability. |

There is a **fourth, separate** mechanism — the generic **Resumable Upload API** (`POST /{app_id}/uploads` → `POST /upload:{session_id}` → returns a file handle `h`) documented at https://developers.facebook.com/docs/graph-api/guides/upload . It accepts only `application/pdf, image/jpeg, image/jpg, image/png, video/mp4`. **It is not the advideos protocol** and I found no documentation that an ad-account video can be created from an `h` file handle. Treat as **UNVERIFIED / do not use for ad videos**; use the `advideos` chunked protocol instead.

> **Fact-check correction (2026-09-02) — this needs re-weighting.** Meta's own current guidance has moved *toward* the Resumable Upload API, not away from it:
> - `https://developers.facebook.com/docs/graph-api/video-uploads` ("Upload Videos to Facebook Guide") now documents **only** the two-step resumable flow (`POST /{app_id}/uploads` → `POST /upload:{session_id}` with a `file_offset` header → `GET /upload:{session_id}` to resume). It no longer describes the `upload_phase` chunked protocol at all.
> - The Video API getting-started page refers to *"A Video handle ID for the video that you have uploaded to Meta servers using the Resumable Upload API."*
> - The Video API publishing guide (`/docs/video-api/guides/publishing`) describes the same three-step resumable workflow and accepts `video/mp4` only.
>
> So the `upload_phase` protocol now survives **only as parameters on the `/advideos` and `/{page_id}/videos` edge references** — no current Meta guide walks through it. It still works, and it is still the only documented path that returns an ad-account-owned `video_id`, but **spike the file-handle path against `/advideos` early**: if it is accepted, it is the better-documented and better-supported route, and Meta is plainly steering there.

### 1.2 Full parameter list for `POST /act_{id}/advideos`

Verbatim from the reference (descriptions quoted):

| Param | Type | Notes |
|---|---|---|
| `source` | string | *"The video, encoded as form data. See the Video Format doc for more details on video formats."* |
| `file_url` | string | Server-side fetch |
| `title` | UTF-8 string | *"The name of the video being uploaded. Must be less than 255 characters. Special characters may count as more than 1 character. Supports Emoji."* |
| `name` | string | *"The name of the video in the library."* |
| `description` | UTF-8 string | *"UTF-8 description string. Supports Emoji."* |
| `upload_phase` | enum | *"The phase during chunked upload. Possible values: start, transfer, finish, cancel."* |
| `upload_session_id` | numeric string | *"The session ID of this chunked upload."* |
| `start_offset` | int64 | *"The start position in byte of the chunk that is being sent, inclusive."* |
| `end_offset` | int64 | exclusive end of the chunk |
| `video_file_chunk` | string | *"The chunk of the video, between start_offset and end_offset."* |
| `file_size` | int64 | *"The size of the video file in bytes. Used during chunked upload."* (required in the `start` phase) |
| `composer_session_id` | string | opaque |
| `source_instagram_media_id` | string | *"The V2 ID of the Instagram video to upload. **Cannot be used with `upload_phase`.**"* |
| `unpublished_content_type` | enum | `SCHEDULED, SCHEDULED_RECURRING, DRAFT, PUBLISH_PENDING, ADS_POST, INLINE_CREATED, PUBLISHED, REVIEWABLE_BRANDED_CONTENT` |
| `transcode_setting_properties` | string | *"Properties used in computing transcode settings for the video."* |
| `original_projection_type` | string | `equirectangular, cubemap, half_equirectangular` (360 video) |
| `original_fov`, `front_z_rotation`, `fisheye_video_cropped` | int64/float/bool | 360/fisheye only |
| `og_object_id`, `og_action_type_id`, `og_icon_id`, `og_phrase`, `og_suggestion_mechanism` | — | Open Graph, irrelevant for ads |
| `audio_story_wave_animation_handle` | string | *"Everstore handle of wave animation used to burn audio story video."* |
| `edit_description_spec`, `prompt_id`, `prompt_tracking_string`, `referenced_sticker_id`, `time_since_original_post` | — | undocumented/internal |

**New in 2026 (Instagram audio swap)** — from https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026 , effective **2026-06-01**:
> *"New parameters on `POST /act_{id}/advideos` to replace copyrighted music on Instagram Reels with royalty-free audio from Meta's Sound Collection. Pass `source_instagram_media_id` with `selected_audio_spec` to create an ad video asset with swapped audio. New `replace_audio_status` and `selected_audio_spec` fields on `GET /{ad-video-id}` to poll async audio swap completion. Check `replace_audio_status` until it returns `SUCCESSFUL` before using the swapped video in ad creative creation."*

This matters for AI-generated video: if your generator lays licensed music over the clip, Instagram Reels will refuse to promote it. The swap path only works from an existing IG media id, so for a fresh file the correct fix is to generate with pre-cleared or synthetic audio in the first place.

### 1.3 Response struct (all phases)

| Field | Type | Meaning |
|---|---|---|
| `id` | numeric string | *"Video ID."* |
| `video_id` | numeric string | *"The created video ID."* (returned by `start`) |
| `upload_session_id` | numeric string | *"The session ID associated with the upload."* |
| `start_offset` | numeric string | *"The next start offset for chunked upload processing."* |
| `end_offset` | numeric string | *"The next end offset for chunked upload processing."* |
| `success` | bool | `finish` phase result |
| `skip_upload` | bool | dedupe — Meta already has these bytes |
| `upload_domain`, `region_hint` | string | shard hints |
| `transcode_bit_rate_bps`, `transcode_dimension`, `should_expand_to_transcode_dimension`, `gop_size_seconds`, `target_video_codec`, `target_hdr`, `maximum_frame_rate` | — | what Meta intends to transcode your file into |
| `xpv_asset_id`, `is_xpv_single_prod`, `action_id` | — | internal |

### 1.4 The chunked protocol, concretely

**Phase `start`** — you send only the total size:
```
POST https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/advideos
  upload_phase=start
  file_size=<TOTAL_BYTES>
  access_token=<TOKEN>
→ { "video_id": "...", "upload_session_id": "...", "start_offset": "0", "end_offset": "52428800" }
```

**Phase `transfer`** — loop. **You do not choose the chunk size.** Meta hands you the next `[start_offset, end_offset)` window in every response; slice exactly that byte range and send it back:
```
POST .../act_<ID>/advideos
  upload_phase=transfer
  upload_session_id=<SESSION>
  start_offset=<FROM_PREVIOUS_RESPONSE>
  video_file_chunk=@<bytes[start:end]>   # multipart binary
→ { "start_offset": "52428800", "end_offset": "104857600" }
```
**Termination condition: loop until the returned `start_offset == end_offset`.** That equality — not a `success` flag, not HTTP 204 — is how the transfer phase signals completion.

> **Fact-check status (2026-09-02): UNVERIFIED.** The `upload_phase` enum (`start, transfer, finish, cancel`), `file_size` (*"The size of the video file in bytes. Using during chunked upload."*), `upload_session_id`, `start_offset` (*"The start position in byte of the chunk that is being sent, inclusive."*), `video_file_chunk` (*"The chunk of the video, between start_offset and end_offset."*) and the response fields `video_id / upload_session_id / start_offset / end_offset / success / skip_upload` are all **confirmed verbatim** on the `advideos` reference. But the three *behavioural* claims below are **not stated in any currently reachable Meta primary source** — they come from the retired `/videos` chunked-upload guide and from SDK behaviour:
> 1. that Meta, not the caller, dictates chunk boundaries;
> 2. that the loop terminates on `start_offset == end_offset`;
> 3. that `finish` is where `title`/`description` are applied.
>
> They are almost certainly still true (every official SDK implements them), but **write the client defensively**: treat `start_offset == end_offset` as the primary exit, and also exit on `end_offset >= file_size` or on any response carrying `"success": true`. Do not assert on a single termination signal.

**Phase `finish`**:
```
POST .../act_<ID>/advideos
  upload_phase=finish
  upload_session_id=<SESSION>
  title=...&description=...        # metadata is applied here
→ { "success": true }
```

**Phase `cancel`** — abandon a session (call it in your error path; orphaned sessions are otherwise invisible garbage).

**Gotcha #2:** `start` already returns `video_id`. That id is real but the asset is unusable until processing finishes (§2). Do not treat the presence of `video_id` as readiness.

**Gotcha #3:** resumption after a crash is done by replaying `transfer` at the last `start_offset` you were given — there is no "query current offset" call on the `advideos` edge (unlike the generic Resumable Upload API, which has `GET /upload:{session_id}` returning `file_offset`). **Persist `upload_session_id` + last offset to durable storage before each chunk**, or a worker restart forces a full re-upload.

**Gotcha #4 (path shape):** *"Do not omit the `act_` prefix in the path"* and *"Do not send `ad_account_id` in the body; it belongs in the URL path."* Both are common 100-errors.

### 1.5 Error codes on `advideos`

| Code | Message |
|---|---|
| 100 | Invalid parameter |
| 190 | Invalid OAuth 2.0 Access Token |
| 200 | Permissions error |
| 222 | *"Video not visible"* |
| 351 | *"There was a problem with your video file. Please try again with another file."* |
| 352 | *"The video file you selected is in a format that we don't support."* |
| 382 | *"The video file you tried to upload is too small. Please try again with a larger file."* |
| 389 | *"Unable to fetch video file from URL."* |
| 6000 / 6001 | *"There was a problem uploading your video…"* (generic; retry) |

352 and 6000 are the two you will hit with machine-generated video: 352 is a container/codec mismatch, 6000 is usually a malformed MP4 (moov atom at the end, or edit lists present).

### 1.6 Container / codec / size limits

Meta's ad-format guide states, for every video placement page checked (https://www.facebook.com/business/ads-guide/update/video/instagram-reels , `.../instagram-story`, `.../facebook-facebook-reels`, https://www.facebook.com/business/ads-guide/video/facebook-feed ):

- **File types:** `MP4`, `MOV` (some placements also accept `GIF`)
- **Video settings (verbatim):** *"H.264 compression, square pixels, fixed frame rate, progressive scan and stereo AAC audio compression at 128kbps+"*
- **Maximum file size: 4 GB** (all ad placements)
- **"Videos should not contain edit lists or special boxes in file containers."**

Meta's broader video specs add: container **MOV or MP4 (MPEG-4 Part 14), no edit lists, moov atom at the front of the file**; codec **HEVC or H264, progressive scan, closed GOP, 4:2:0 chroma subsampling**; audio **AAC, 48 kHz max, 1–2 channels**; audio bitrate **128 kbps**.

> **Fact-check correction (2026-09-02).** ~~video bitrate **VBR, 100 Mbps max**~~ — **wrong**. The primary source for this whole block is the Instagram Platform reel/video specifications table (https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media#reel-specifications), which states verbatim: *"VBR, 25Mbps maximum"*. It also carries three constraints the draft omitted: **frame rate 23–60 FPS**, **maximum 1920 horizontal pixels**, and **duration 3 s minimum / 15 min maximum**.
>
> **Second correction — these are ORGANIC Instagram publishing specs, not ad specs.** The same table gives a **300 MB** file-size limit for reels and **100 MB** for stories, against the 4 GB the ads-guide pages give for ad placements. Do not merge the two tables. For *ads*, the ads-guide numbers (4 GB, H.264, square pixels, fixed frame rate, progressive scan, stereo AAC 128 kbps+, no edit lists) govern; the moov-atom / 4:2:0 / closed-GOP / 23–60 fps details are best read as **encoder hygiene that Meta's transcoder is known to want**, not as published ad requirements. Encoding to the stricter organic spec is still the right call — it satisfies both — but do not tell anyone Meta *documents* those as ad requirements.

**Practical ffmpeg recipe for an AI-generated clip** (satisfies every constraint above):
```
ffmpeg -i in.mp4 -c:v libx264 -profile:v high -pix_fmt yuv420p \
  -x264-params "keyint=60:min-keyint=60:scenecut=0" \
  -r 30 -b:v 8M -maxrate 12M -bufsize 16M \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart -video_track_timescale 30000 out.mp4
```
`-movflags +faststart` moves the moov atom to the front. `-pix_fmt yuv420p` forces 4:2:0 (many generative video models emit yuv444p or 10-bit, which Meta rejects with 352). Fixed `-r` avoids VFR, which is the #1 cause of "processed but audio drifts" complaints.

**Note the contradiction:** the App Ads video-ad page (https://developers.facebook.com/docs/app-ads/formats/video-ad) says *"File size: up to 1 GB"*, while every ads-guide placement page says 4 GB. The 4 GB figure is the one attached to the actual ad placements; treat 1 GB as an app-ads-specific ceiling. **Recommended practical cap for an automated pipeline: keep renders under ~200 MB.** Nothing about ad creative benefits from a 4 GB master, and upload time is your pipeline's tail latency.

---

## 2. Async processing and status polling

After upload the asset is transcoded asynchronously. **Creating an ad creative that references a not-yet-`ready` `video_id` fails or produces an ad stuck in review/"Preparing".**

### 2.1 The call

```
GET https://graph.facebook.com/v26.0/{video_id}?fields=status&access_token=<TOKEN>
```
Source (documented for the Reels publishing flow but the `status` field is the same node field): https://developers.facebook.com/docs/video-api/guides/reels-publishing — *"To get the status of a video, send a `GET` request to the `/video-id` endpoint … with `fields` set to `status`."*

### 2.2 Response shape and enums

```json
{
  "status": {
    "video_status": "processing",
    "uploading_phase":  { "status": "complete",    "bytes_transfered": 12345678,
                          "source_file_size": 12345678, "errors": [] },
    "processing_phase": { "status": "in_progress", "error": { "message": "..." } },
    "publishing_phase": { "status": "not_started", "publish_status": "draft",
                          "publish_time": 1780000000, "error": {} }
  },
  "id": "..."
}
```

| Field | Values |
|---|---|
| `status.video_status` | `uploading`, `upload_complete`, `upload_failed`, `processing`, `ready`, `error`, `expired` |
| `*_phase.status` | `not_started`, `in_progress`, `complete` / `completed`, `error` |
| `publishing_phase.publish_status` | `draft`, `scheduled`, `published`, `error` |

(The phase-status enum is documented as `not_started / in_progress / complete / error` on the general publishing guide and as `completed` on the Reels guide — **accept both spellings**; do not `assert status == "complete"`.)

> **Fact-check additions (2026-09-02).**
> - **Confirmed:** the seven-value `video_status` enum (`uploading, upload_complete, upload_failed, processing, ready, error, expired`), the three phase objects, the phase-status values, and Meta's misspelling **`bytes_transfered`** are all verbatim on https://developers.facebook.com/docs/video-api/guides/reels-publishing . That page spells the terminal phase status **`completed`** (not `complete`), which is the safer default to match on.
> - **MISSED BY THE DRAFT — `processing_progress`.** The `VideoStatus` node reference (https://developers.facebook.com/docs/graph-api/reference/video-status/) documents a second field: **`processing_progress`** (unsigned int32) — *"Video processing progress in percent [int 0 to 100]."* Request it (`?fields=status{video_status,processing_progress,uploading_phase,processing_phase,publishing_phase}`) and you get a real progress signal instead of a blind backoff loop. Use it to distinguish "slow but advancing" from "wedged" before the 15-minute hard timeout fires.
> - **Docs disagree with each other.** The `VideoStatus` node reference lists **only** `ready / processing / error` for `video_status` — *"either 'ready' (uploaded, encoded, thumbnails extracted), 'processing' (not ready yet) or 'error' (processing failed)"* — while the Reels publishing guide lists all seven. Handle all seven; treat anything unrecognised as non-terminal and keep polling until the timeout.

### 2.3 Polling strategy for an autonomous pipeline

- **Gate:** never call `POST /adcreatives` until `status.video_status == "ready"`.
- **Latency:** typically seconds to a couple of minutes for a <100 MB 9:16 clip; longer for 4K/long-form. Meta publishes no SLA — **UNVERIFIED**.
- **Backoff:** poll at 2 s → 5 s → 10 s → 15 s, cap at 15 s, **hard timeout at 15 minutes**, then treat as failed and re-upload. Videos genuinely do get stuck ("Preparing" forever) — Meta's own ads UI has the same failure mode.
- **Failure detection:** `video_status == "error"` OR any `*_phase.status == "error"`. Read `processing_phase.error.message` — it is the only human-readable reason you will get.
- **`expired`** is a real terminal state: ad-account videos are not permanent. Do not cache `video_id`s across long time horizons without re-checking.
- `bytes_transfered` (note Meta's spelling, one `r`) on `uploading_phase` is the resume/progress signal.

**Gotcha #5:** polling `GET /{video_id}` with a **user** token when the video lives in an ad account can return error 222 *"Video not visible"*. Use the same system-user token that performed the upload, and always scope reads to the ad account that owns the asset (*"The `video_id` must be associated with the ad account"* — https://developers.facebook.com/docs/marketing-api/guides/videoads/).

**Gotcha #6:** the public `Video` node reference (https://developers.facebook.com/docs/graph-api/reference/video/) no longer lists `status`, `length`, `thumbnails`, or `permalink_url` in its Fields table. The fields still work; the docs page was trimmed. Do not conclude a field is gone because the reference omits it — test it in the Graph API Explorer.

---

## 3. Thumbnails

A video creative renders a **poster frame** before playback. Meta auto-generates candidates; you can also supply your own.

### 3.1 Reading auto-generated thumbnails

```
GET /v26.0/{video_id}/thumbnails
```
Source: https://developers.facebook.com/docs/graph-api/reference/video/thumbnails/

Returns `{ "data": [ VideoThumbnail... ], "paging": {...} }`, each element:

| Field | Example |
|---|---|
| `id` | `"video-id-1"` |
| `height` / `width` | `1280` / `720` |
| `scale` | `1` |
| `uri` | CDN URL of the JPEG |
| `is_preferred` | `false` |

Poll this **after** `video_status == "ready"` — the edge is empty or partial during processing.

### 3.2 Setting a preferred / custom thumbnail

```
POST /v26.0/{video_id}/thumbnails
  source=@poster.jpg      # required, max 10 MB
  is_preferred=true       # optional
→ { "success": true }
```
Constraints per the same reference: thumbnails apply to **videos associated with Pages**, and *"should match the video's aspect ratio."*

**Gotcha #7:** for ad videos the more reliable route is not `/thumbnails` at all — it is to upload the poster to `/adimages` and pass its `image_hash` into `video_data`. `/{video_id}/thumbnails` is a Page-video surface and its behaviour on `advideos`-uploaded assets is inconsistent (**UNVERIFIED** whether `is_preferred` on an ad video is honoured by the ad renderer).

### 3.3 `POST /act_{ad_account_id}/adimages`

Reference: https://developers.facebook.com/docs/marketing-api/reference/ad-account/adimages/

Documented params: `bytes` (Base64 UTF-8 string — *"Image file"*), and `copy_from` (`{source_account_id, hash}` to clone an image between accounts). In practice the multipart form-file variant works and is what every SDK uses:
```
curl -F "poster.jpg=@/path/poster.jpg" -F "access_token=<TOKEN>" \
  https://graph.facebook.com/v26.0/act_<ID>/adimages
```
Response is keyed by the **field name you used**, not by a fixed key:
```json
{ "images": { "poster.jpg": {
    "hash": "a1b2c3…", "url": "https://scontent…",
    "url_128": "…", "url_256": "…", "url_256_height": 256, "url_256_width": 256,
    "width": 1080, "height": 1920, "name": "poster.jpg" } } }
```
**Gotcha #8:** the response map key is the multipart field name. If you upload with field name `bytes` you get back `{"images":{"bytes":{...}}}`. Read the single value of the map rather than looking up a constant key.

`GET /act_{id}/adimages` filters: `hashes` (list<string>), `minwidth`, `minheight`, `name`, `business_id`, `biz_tag_id`. Ad-label filtering is **not** in the documented GET params.

### 3.4 `image_hash` vs `image_url` in the creative

`AdCreativeVideoData` accepts **both**:
- `image_hash` — *"Thumbnail image hash from library"* (an `/adimages` hash owned by the same ad account)
- `image_url` — a URL Meta fetches

**Use `image_hash`.** `image_url` requires Meta to fetch at creative-creation time; it fails silently/slowly on private CDNs, signed URLs, and anything behind auth, and the fetched asset is not reusable across creatives. `image_hash` is deterministic, dedupes across creatives, and lets you validate dimensions before the ad exists. Meta's own quickstart uses `image_url` (`"video_data": {"image_url":"<THUMBNAIL_URL>","video_id":"<VIDEO_ID>"}`, https://developers.facebook.com/docs/marketing-api/guides/videoads/) — that is a docs simplification, not a recommendation.

**Poster generation for an automated pipeline:** extract a frame at ~1.5 s (`ffmpeg -ss 1.5 -i out.mp4 -frames:v 1 poster.jpg`), at the **same aspect ratio as the video**, min 1080 px on the short edge. A 16:9 poster on a 9:16 video produces pillarboxed grey bars in Feed.

---

## 4. The ad creative for a single video

### 4.1 `object_story_spec`

Reference: https://developers.facebook.com/docs/marketing-api/reference/ad-creative-object-story-spec/

| Field | Description (verbatim) |
|---|---|
| `page_id` | *"ID of a Facebook page. An unpublished page post will be created on this page."* |
| `instagram_user_id` | *"The Instagram user account that the ad will be posted to"* |
| `video_data` | *"The spec for a video page post"* |
| `link_data` | *"The spec for a link page post or carousel ad"* |
| `photo_data`, `template_data`, `product_data`, `text_data` | other post types |

**`instagram_actor_id` is gone.** It is not in the v26.0 reference at all. Migration (https://developers.facebook.com/blog/post/2025/08/11/instagram-marketing-api-update/):
- `instagram_actor_id` → **`instagram_user_id`**
- `instagram_story_id` → **`source_instagram_media_id`**
- `effective_instagram_story_id` → **`effective_instagram_media_id`**
- Effective from **Marketing API v22.0**; *"After September 9, 2025, there will be no Marketing API version available that"* supports the legacy fields — this **accelerated** the previously announced 2026-01-21 deadline.
- Ten endpoints affected, including `POST /act_{id}/adcreatives`, `POST /act_{id}/ads`, `POST /act_{id}/asyncadrequestsets`, `GET /adcreative`, and both `/generatepreviews` edges.

Note `instagram_user_id` **also exists as a top-level field on the AdCreative node** (https://developers.facebook.com/docs/marketing-api/reference/ad-creative/). Set it inside `object_story_spec`; the top-level field is what you read back. Setting both to different values is undefined — **UNVERIFIED**, don't.

### 4.2 `AdCreativeVideoData` — complete field list

Reference: https://developers.facebook.com/docs/marketing-api/reference/ad-creative-video-data/

| Field | Type | Description |
|---|---|---|
| `video_id` | numeric string | *"ID of video that user has permission to"* — verbatim. *(Fact-check: the draft's "…or a video in ad account video library" is **not** in the reference; it is an SDK-docs paraphrase. The practical requirement still holds — see Gotcha #5.)* |
| `image_hash` | string | thumbnail hash from the ad-account image library |
| `image_url` | string | thumbnail URL |
| `message` | string | the **primary text** / post body |
| `title` | string | the **headline** |
| `link_description` | string | *"Link description of the video. Overwrites the description in the video post on Facebook"* |
| `call_to_action` | AdCreativeLinkDataCallToAction | *"An optional call to action"* |
| `caption_ids` | list<numeric string> | *"The caption ids of the videos"* (per-locale subtitle tracks) |
| `additional_image_index` | int32 | index into the additional-images array |
| `customization_rules_spec` | list<AdCustomizationRuleSpec> | dynamic-ad customization |
| `collection_thumbnails` | list<AdCreativeCollectionThumbnailInfo> | Collection/Instant Experience |
| `retailer_item_ids` | list<string> | *"List of product IDs provided by the advertiser for Collections"* |
| `offer_id` | numeric string | *"The id of a Facebook native offer"* |
| `page_welcome_message` | string | Messenger greeting |
| `post_click_configuration` | AdCreativePostClickConfiguration | post-click experience |
| `targeting` | Targeting | *"The post gating for the video"* |
| `branded_content_sponsor_page_id` / `branded_content_shared_to_sponsor_status` / `branded_content_sponsor_relationship` | — | branded content |

### 4.3 The single biggest structural gotcha

**Gotcha #9 — `video_data` has NO `link` field.** Unlike `link_data`, there is no `video_data.link`. The destination URL lives **only** in `call_to_action.value.link`:

```json
"call_to_action": {
  "type": "SHOP_NOW",
  "value": { "link": "https://example.com/product" }
}
```

And per the CTA-value reference (https://developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data-call-to-action-value/), `link` is *"The destination link when the CTA button is clicked. **This is required to be same as the link url of the creative.**"* So for a video ad with `type: "NO_BUTTON"` you **still must supply `call_to_action.value.link`** or the ad has no clickthrough destination. This costs people a day.

`AdCreativeLinkDataCallToActionValue` fields: `link`, `link_caption` (*"must be an actual URL"*), `link_format`, `app_destination`, `app_link`, `application`, `event_id`, `lead_gen_form_id`, `page`, `product_link`.

### 4.4 Worked example — full single-video creative + ad

```bash
# 1. Upload video (chunked) → VIDEO_ID ; poll until status.video_status == "ready"
# 2. Upload poster → IMAGE_HASH

# 3. Creative
curl -X POST "https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/adcreatives" \
 -F 'name=AIGEN-2026-09-02-variant-07' \
 -F 'object_story_spec={
      "page_id": "<PAGE_ID>",
      "instagram_user_id": "<IG_USER_ID_OR_PBIA_ID>",
      "video_data": {
        "video_id": "<VIDEO_ID>",
        "image_hash": "<IMAGE_HASH>",
        "message": "Primary text goes here.",
        "title": "Headline goes here",
        "link_description": "Secondary description",
        "call_to_action": {
          "type": "SHOP_NOW",
          "value": { "link": "https://example.com/lp" }
        }
      }
    }' \
 -F 'url_tags=utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&fb_placement={{placement}}&fb_site={{site_source_name}}' \
 -F 'degrees_of_freedom_spec={"creative_features_spec":{
        "standard_enhancements":{"enroll_status":"OPT_OUT"},
        "video_auto_crop":{"enroll_status":"OPT_OUT"},
        "video_uncrop":{"enroll_status":"OPT_OUT"},
        "video_filtering":{"enroll_status":"OPT_OUT"},
        "text_optimizations":{"enroll_status":"OPT_OUT"},
        "image_animation":{"enroll_status":"OPT_OUT"}}}' \
 -F 'access_token=<TOKEN>'

# 4. Ad
curl -X POST "https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/ads" \
 -F 'name=AIGEN v07' -F 'adset_id=<ADSET_ID>' \
 -F 'creative={"creative_id":"<CREATIVE_ID>"}' \
 -F 'status=PAUSED' -F 'access_token=<TOKEN>'
```
(Canonical minimal shape confirmed at https://developers.facebook.com/docs/marketing-api/guides/videoads/ ; permissions required there: **`pages_read_engagement` and `ads_management`**.)

### 4.5 Other AdCreative fields worth knowing

From https://developers.facebook.com/docs/marketing-api/reference/ad-creative/ :
- `url_tags` — creative-level tracking query string (§10)
- `authorization_category` — enum includes **`POLITICAL`** and **`POLITICAL_WITH_DIGITALLY_CREATED_MEDIA`**. The second value is the API surface for the AI-media disclosure on social-issue/election/political ads (§11).
- `asset_feed_spec`, `degrees_of_freedom_spec` (§6–7)
- `generative_asset_spec`, `creative_sourcing_spec`, `media_sourcing_spec`, `format_transformation_spec`, `contextual_multi_ads` — present in v26.0 but **undocumented in the public reference** (**UNVERIFIED** shapes)
- `threads_media_id`, `threads_user_id` — Threads ads
- `effective_object_story_id`, `effective_instagram_media_id` — read-back of the actual published post ids; useful for reconciling "what actually shipped"
- `status` on the creative is separate from ad status. **Full enum: `ACTIVE`, `IN_PROCESS`, `WITH_ISSUES`, `DELETED`** *(fact-check correction — the draft listed only `ACTIVE`/`DELETED`; `IN_PROCESS` and `WITH_ISSUES` are the two states an autonomous pipeline actually needs to branch on)*

---

## 5. Instagram placements without an Instagram account — PBIA

To run Instagram placements you need an `instagram_user_id` in `object_story_spec`. If the advertiser has no IG account, create a **Page-Backed Instagram Account (PBIA)**: a shadow IG identity derived from the Facebook Page.

### 5.1 Endpoints

```
# Read existing PBIA(s)
GET  https://graph.facebook.com/v26.0/<PAGE_ID>/page_backed_instagram_accounts
       ?fields=username,profile_pic&access_token=<PAGE_OR_SYSTEM_USER_TOKEN>

# Create one (no body params needed)
POST https://graph.facebook.com/v26.0/<PAGE_ID>/page_backed_instagram_accounts
       access_token=<TOKEN>
→ { "id": "<IG_USER_ID>" }
```
Also readable as a Page field: `GET /<page-id>?fields=connected_page_backed_instagram_account` — *"In v9.0 and later, the field can return an Instagram User ID (IG User), if available"* (https://developers.facebook.com/docs/graph-api/changelog/version9.0).

The returned id goes straight into `object_story_spec.instagram_user_id`.

### 5.2 Behaviour and limits

Per Meta's original PBIA announcement (https://developers.facebook.com/ads/blog/post/v2/2015/12/16/ig-accounts/), still the clearest primary statement:
- The PBIA *"gets the name and profile picture from the Page and can be used to run ads."*
- It **cannot** perform organic activity — no non-ad posts, no comments, no likes.
- Ads from a PBIA show *"a non-clickable profile name in black, instead of the regular blue clickable profile name."*

**Design consequences for a fully-automated platform:**
1. **Idempotency:** POST first, then GET — repeated POSTs to the same Page appear to return the existing account rather than creating duplicates (**UNVERIFIED**; implement as GET-then-POST-if-empty and cache the id per Page).
2. **Branding cost is real.** A PBIA ad looks visibly second-class on Instagram (black, non-clickable handle). If the advertiser has *any* real IG account, connect it. Only fall back to PBIA when onboarding must not block.
3. **`connected_page_backed_instagram_account` vs `page_backed_instagram_accounts`** are different surfaces on the same concept; read both when reconciling state.
4. **Threads:** as of **2026-04-21**, *"Page-backed Threads accounts are now available for creating Threads ads"* (https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026). Same pattern, new surface.

### 5.3 The other half of the Instagram migration

Any edge that previously returned an `Instagram User` now returns an **`IG User`** object (https://ppc.land/meta-simplifies-instagram-and-marketing-api-integrations/). Graph API endpoints stopped accepting legacy Instagram account objects on **2025-04-21**; Marketing API endpoints on **2026-01-21**. If any stored `instagram_actor_id` values survive in your database from an older integration, they are legacy-object ids and **will not work** as `instagram_user_id`. Re-resolve them from the Page.

---

## 6. Multiple videos in one ad — `asset_feed_spec`

Three distinct products share one field. Which one you get is determined by `optimization_type` plus whether `asset_customization_rules` is present.

`optimization_type` enum (https://developers.facebook.com/docs/marketing-api/reference/ad-asset-feed-spec/):
**`REGULAR`, `PLACEMENT`, `ASSET_CUSTOMIZATION`, `LANGUAGE`, `FORMAT_AUTOMATION`**

| Product | `optimization_type` | `asset_customization_rules` | Meta picks the combination? |
|---|---|---|---|
| Dynamic Creative | `REGULAR` | **must be absent** | Yes — algorithmic |
| Placement Asset Customization | `PLACEMENT` | **required, ≥2 rules** | No — you declare the mapping |
| Multi-language ads | `LANGUAGE` | required, one `is_default` | No — by locale |

Docs: https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/ — *"For Dynamic Creative: `asset_feed_spec` should **not** have customization rules."*

### 6.1 Complete `AdAssetFeedSpec` field list

| Field | Type |
|---|---|
| `ad_formats` | list<enum> — `SINGLE_IMAGE`, `CAROUSEL`, `SINGLE_VIDEO`, `AUTOMATIC_FORMAT` |
| `videos` | list<AdAssetFeedSpecVideo> |
| `images` | list<AdAssetFeedSpecImage> |
| `bodies` / `titles` / `descriptions` | list<…Body/Title/Description> — each `{ "text": "…", "adlabels": [...] }` |
| `link_urls` | list — `{ "website_url": "…", "deeplink_url": "…" }` |
| `call_to_action_types` | list<enum> |
| `call_to_actions` | list<AdAssetFeedSpecCallToAction> |
| `captions` | list<AdAssetFeedSpecCaption> |
| `audios` | list<AdAssetAudios> |
| `asset_customization_rules` | list<AdAssetFeedSpecAssetCustomizationRule> |
| `optimization_type` | enum (above) |
| `groups` | list<AdAssetFeedSpecGroupRule> |
| `additional_data` | AdAssetFeedAdditionalData |
| `autotranslate` / `translations` | list<string> / list<AdAssetTranslations> |
| `message_extensions` | list — values `whatsapp`, `messenger`, `instagram_message` |
| `onsite_destinations`, `shops_bundle`, `reasons_to_shop` | Shops ads |
| `events`, `promotional_metadata`, `call_ads_configuration`, `ctwa_consent_data`, `app_product_page_id`, `web_destination_spec` | specialised |

`AdAssetFeedSpecVideo` (https://developers.facebook.com/docs/marketing-api/reference/ad-asset-feed-spec-video/):

| Field | Description |
|---|---|
| `video_id` | *"Id of the video used for your ad"* |
| `thumbnail_hash` | *"Hash of the thumbnail url for the video used for your ad"* |
| `thumbnail_url` | *"Thumbnail url for the video used for your ad"* |
| `adlabels` | *"Ad Label spec of the asset used for your ad"* — this is how customization rules reference it |
| `caption_ids` | *"…an array of caption IDs for different locales"* |
| `url_tags` | *"URL tags spec of the asset used for your ad"* — **per-asset UTMs** |

**Gotcha #10:** it is `thumbnail_hash` inside `asset_feed_spec.videos`, but `image_hash` inside `object_story_spec.video_data`. Same concept, two names, one letter of difference in your serializer.

### 6.2 Hard limits

From https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/options/ : **maximum 30 total assets**, and within that:
- images ≤ 10, videos ≤ 10
- bodies ≤ 5 (**1024 chars each**), titles ≤ 5 (**255 chars each**), descriptions ≤ 5 (**255 chars each**)
- call_to_action_types ≤ 5, link_urls ≤ 5
- `ad_formats`: *"One format per feed"*

### 6.3 Dynamic Creative

Docs: https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/dynamic-creative/

- **Enabled on the AD SET**, not the creative: `is_dynamic_creative=true`.
- Supported objectives: `OUTCOME_SALES`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_APP_PROMOTION`.
- `buying_type` must be `AUCTION` or blank.
- **"You can only create one ad per ad set"** and **"Your ad set must be empty"** when creating the Dynamic Creative ad.
- **You cannot delete or archive the ad directly** — you must delete/archive the parent ad set. This is a genuine architectural constraint for an autonomous optimiser: *the ad set is the unit of lifecycle, not the ad.*
- Format is frozen: *"you cannot change ad formats, such as from `SINGLE IMAGE` to `VIDEO`"*, and a Dynamic Creative ad cannot be converted to a non-asset-feed ad.
- `asset_feed_id` was removed after Marketing API v3.1.
- `sponsored_messages` on Messenger not supported.

Ad set:
```bash
curl -F 'name=DC Ad Set' -F 'campaign_id=<CAMPAIGN_ID>' \
     -F 'optimization_goal=OFFSITE_CONVERSIONS' \
     -F 'is_dynamic_creative=true' \
     -F 'billing_event=IMPRESSIONS' -F 'bid_strategy=LOWEST_COST_WITHOUT_CAP' \
     -F 'promoted_object={"pixel_id":"<PIXEL_ID>","custom_event_type":"PURCHASE"}' \
     -F 'targeting={"geo_locations":{"countries":["US"]}}' \
     -F 'lifetime_budget=5000' -F 'status=PAUSED' -F 'access_token=<TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/adsets
```

Creative — note `object_story_spec` **must still be present** to carry identity, even though the assets live in `asset_feed_spec`:
```bash
curl -F 'object_story_spec={"page_id":"<PAGE_ID>","instagram_user_id":"<IG_USER_ID>"}' \
     -F "asset_feed_spec={
        'videos': [{'video_id':'<VID_1>','thumbnail_hash':'<H1>'},
                   {'video_id':'<VID_2>','thumbnail_hash':'<H2>'}],
        'bodies': [{'text':'Body A'},{'text':'Body B'}],
        'titles': [{'text':'Headline A'},{'text':'Headline B'}],
        'descriptions': [{'text':'Desc A'}],
        'ad_formats': ['SINGLE_VIDEO'],
        'call_to_action_types': ['SHOP_NOW'],
        'optimization_type': 'REGULAR',
        'link_urls': [{'website_url':'https://example.com/lp'}]}" \
     -F 'access_token=<TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/adcreatives
```
(Identity-alongside-assets shape confirmed by the official deep-links example at https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/options/ , which shows `object_story_spec` with only `page_id` + `instagram_user_id` paired with a full `asset_feed_spec`.)

**Gotcha #11:** with `asset_feed_spec` present, do **not** also populate `object_story_spec.video_data`. `object_story_spec` degenerates to an identity envelope (`page_id`, `instagram_user_id`). Sending both produces confusing "object_story_spec is invalid" errors that actually originate in the asset feed.

### 6.4 Flexible ad format — `creative_asset_groups_spec`

Docs: https://developers.facebook.com/documentation/ads-commerce/marketing-api/flexible-ad-format

A **different field from `asset_feed_spec`**, set on the **ad**, not the creative. Groups of assets that Meta assembles per impression.

- Objectives: *"Currently only `OUTCOME_SALES` and `OUTCOME_APP_PROMOTION` campaign objectives support the flexible ad format."*
- *"Each group requires at least 1 `image` or `video`"*
- *"There can be no more than 5 `texts` per `text_type` in a group"*
- *"All `call_to_actions` provided must have the same `type`"*
- `text_type` enum: `primary_text`, `headline`, `description`

```bash
curl -F 'adset_id=<ADSET_ID>' \
  -F "creative={'name':'Sample Creative','object_story_spec':{...}}" \
  -F 'creative_asset_groups_spec={
    "groups": [{
      "images": [{"hash": <IMAGE_HASH_1>}, {"hash": <IMAGE_HASH_2>}],
      "videos": [{"video_id": <VIDEO_ID_1>}, {"video_id": <VIDEO_ID_2>}],
      "texts":  [{"text":"Summer Sale","text_type":"primary_text"},
                 {"text":"Everything 50% Off","text_type":"headline"}],
      "call_to_action": {"type":"LEARN_MORE","value":{"link":"https://www.example.com/"}}
    }]}' \
  -F 'status=PAUSED' -F 'access_token=<ACCESS_TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/ads
```
Read-back adds `group_uuid` per group and echoes each video with its `image_hash` (the thumbnail). Note the **third** name for the same concept: `videos[].image_hash` here, `thumbnail_hash` in `asset_feed_spec`, `image_hash` in `video_data`.

**UI/API divergence (2026):** secondary sources report Meta removed the "Flexible" format from the Ads Manager UI in **March 2026**, redistributing it across "Format display options", "Flexible media" and Advantage+ Creative (https://www.campaignbuilder.io/blogs/meta-flexible-ads-removed-2026 , https://metricool.com/flexible-ads-meta/). The **API doc is still live and carries no deprecation notice**. Official docs win: `creative_asset_groups_spec` is still the documented API surface. Treat the UI change as cosmetic but **do not build the core pipeline on flexible format** — it is objective-restricted and clearly in flux.

---

## 7. Placement asset customization — shipping 9:16 and 1:1 in one ad

This is the mechanism you want for an AI-video pipeline: render **one concept in multiple aspect ratios**, ship them in a single ad, and let each placement serve its native cut.

Docs: https://developers.facebook.com/documentation/ads-commerce/marketing-api/dynamic-creative/placement-asset-customization

### 7.1 Mechanics

1. Put every video in `asset_feed_spec.videos`, each tagged with an **ad label**:
   ```json
   "videos": [{ "adlabels": [{"name": "vertical_9x16"}], "video_id": "<VID_A>",
                "thumbnail_hash": "<H_A>" },
              { "adlabels": [{"name": "square_1x1"}],   "video_id": "<VID_B>",
                "thumbnail_hash": "<H_B>" }]
   ```
2. Add `asset_customization_rules`, each pairing a `customization_spec` (placement selector) with a `video_label` (asset selector):
   ```json
   { "customization_spec": { "publisher_platforms": ["facebook"],
                             "facebook_positions": ["feed"] },
     "video_label": { "name": "square_1x1" } }
   ```
3. Set `optimization_type: "PLACEMENT"`.

**Hard rule:** *"For Placement Asset Customization, every `asset_feed_spec` needs to have more than one customization rule attached to it."* / *"All ads using `asset_feed_spec` must contain at least two target customization rules."* (https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/asset-feed-spec/asset-customization-rules). **One rule is always an error.**

### 7.2 `AdAssetFeedSpecAssetCustomizationRule` fields

https://developers.facebook.com/docs/marketing-api/reference/ad-asset-feed-spec-asset-customization-rule/

| Field | Description |
|---|---|
| `customization_spec` | *"Customization spec associated with this Asset customization Rule"* |
| `video_label` | *"Ad Asset video label spec associated with this Asset Target Rule"* |
| `image_label`, `carousel_label`, `body_label`, `title_label`, `description_label`, `caption_label`, `call_to_action_label`, `call_to_action_type_label`, `link_url_label` | same pattern for other asset types |
| `priority` | int32 — *"The priority number based on the position of this Asset Target Rule in list"* |
| `is_default` | bool — *"(Only Multi-Language ad) Indicate if the rule will act as a fallback when other rules don't match"* |

**Gotcha #12:** `is_default` is documented as **multi-language only**. For placement customization there is no "default rule" field — coverage is achieved by making your rule set exhaustive over the ad set's `targeting.publisher_platforms` / `*_positions`. If a placement in the ad set matches no rule, behaviour is undefined (**UNVERIFIED**; in practice the ad set's effective placements shrink). **Always derive your rule set from the ad set's actual placement list, or pin the ad set to an explicit placement list you also enumerate in rules.**

### 7.3 Platforms/positions accepted inside `customization_spec`

Per the placement-asset-customization doc:

| Platform | Positions |
|---|---|
| `facebook` | `feed`, `right_hand_column`, `marketplace`, `video_feeds`, `search`, `story`, `notification` |
| `instagram` | `stream`, `story`, `explore`, `explore_home`, `profile_feed`, `ig_search` |
| `messenger` | `sponsored_messages`, `story` |
| `audience_network` | `classic`, `instream_video`, `rewarded_video` |
| `threads` | `threads_stream` |

**This table lags the placement-targeting enum** (below) — it omits `facebook_reels`, `facebook_reels_overlay`, `instagram` `reels` and `profile_reels`, and still lists `messenger` `story` which v26.0 silently drops. Meta's canonical placement enum (https://developers.facebook.com/docs/marketing-api/audiences/reference/placement-targeting/):

| Key | Values |
|---|---|
| `publisher_platforms` | `facebook`, `instagram`, `threads`, `messenger`, `audience_network` |
| `facebook_positions` | `feed`, `right_hand_column`, `marketplace`, `video_feeds`, `story`, `search`, `instream_video`, **`facebook_reels`**, **`facebook_reels_overlay`**, `profile_feed`, `notification` |
| `instagram_positions` | `stream`, `story`, `explore`, `explore_home`, **`reels`**, `profile_feed`, `ig_search`, **`profile_reels`** |
| `messenger_positions` | `sponsored_messages`, `story` *(story removed in v26.0)* |
| `audience_network_positions` | `classic`, `rewarded_video` |
| `threads_positions` | `threads_stream` |
| `device_platforms` | `mobile`, `desktop` |

**Gotcha #13:** these two pages disagree, and the changelog disagrees with both (v26.0 removed *"the Instagram Explore Feed placement"* while `explore`/`explore_home` are still enumerated). **Do not hard-code the position list.** Read `effective_...` placement fields back from the created ad set and reconcile; treat unknown-value errors as a signal to re-scrape.

### 7.4 Other constraints

- *"Placement Asset Customization with existing posts is no longer supported via the API"* — you cannot customize per-placement on an `object_story_id` (boosted-post) creative. For a fully automated pipeline this is fine; you are always creating unpublished page posts anyway.
- Only **one** link description is allowed; it cannot be customized per placement.
- `explore_home` *"only supports the `SINGLE_IMAGE` format"* — **no video** there.
- Threads requires `publisher_platform: instagram` + `instagram_positions: stream` as a prerequisite.
- Carousels: *"all child attachments must be defined within the Asset Feed Spec and referenced via `adlabels`"* — you cannot define child attachments inline.

### 7.5 Recommended render matrix for a video-generation pipeline

| Cut | Placements to map | Rationale |
|---|---|---|
| **9:16, 1080×1920** (master) | `instagram: reels, story, profile_reels`; `facebook: facebook_reels, story`; `threads: threads_stream` | Native full-screen surfaces; ~all mobile inventory |
| **4:5, 1080×1350** | `facebook: feed`; `instagram: stream, profile_feed` | Feed's tallest allowed ratio → max screen real estate without Reels cropping |
| **1:1, 1080×1080** | `facebook: facebook_reels_overlay`, `marketplace`, `video_feeds`, `search`; `instagram: ig_search`, `explore` | The Reels-overlay/post-loop placement is explicitly **1:1** (§8) |
| **16:9, 1920×1080** | `audience_network: instream_video`; `facebook: instream_video` | Only if you buy in-stream at all |

Rendering 9:16 → 4:5/1:1 is a crop, not a re-generation, so it costs one ffmpeg pass. Doing this yourself is strictly better than letting `video_uncrop`/`video_auto_crop` do it (§8), because you control the framing of the subject.

---

## 8. Advantage+ Creative / `degrees_of_freedom_spec` — and how to turn it OFF

This is the single most important brand-control surface, because **Meta will silently alter your AI-generated video** otherwise.

Structure (https://developers.facebook.com/docs/marketing-api/reference/ad-creative-degrees-of-freedom-spec/):
```json
"degrees_of_freedom_spec": {
  "creative_features_spec": {
    "<FEATURE_KEY>": { "enroll_status": "OPT_IN" | "OPT_OUT" }
  }
}
```
Some features take nested `customizations`:
```json
"enhance_cta": { "enroll_status":"OPT_IN",
                 "customizations": { "text_extraction": {"enroll_status":"OPT_IN"} } }
```

### 8.1 The `standard_enhancements` bundle is dead

From https://developers.facebook.com/blog/post/2025/01/17/marketing-api-v22-impacts-to-advantage-plus-creative-enhancements/ :
- The bundle `{"standard_enhancements":{"enroll_status":"OPT_IN"}}` was **deprecated in Marketing API v22.0 (2025-01-21)**; no new or edited ad may use it.
- 90-day grace period ended **2025-04-21**.
- It decomposed into, for **single video ads**: `video_auto_crop` ("Visual touch-ups"), `text_optimizations` ("Text improvements"), `inline_comment` ("Relevant comments").
- For single image ads: `image_template`, `image_touchups`, `text_optimizations`, `inline_comment`.

Meta's own standard-enhancements page still shows the old bundle JSON with a warning that *"opting in or out of standard enhancements will no longer be available"* — the page is stale (https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads/standard-enhancements). **Trust the v22.0 blog post and the per-feature list.**

### 8.2 Complete feature key list

`AdCreativeFeaturesSpec` fields (https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/) — all typed `AdCreativeFeatureDetails`:

`adapt_to_placement`, `add_text_overlay`, `ads_with_benefits`, `biz_ai`, `creative_stickers`, `customize_product_recommendation`, `description_automation`, `fb_feed_tag`, `fb_reels_tag`, `fb_story_tag`, `generate_cta`, `hide_price`, `ig_feed_tag`, `ig_reels_tag`, `ig_stream_tag`, `image_animation`, `image_background_gen`, `image_templates`, `image_touchups`, `inline_comment`, `local_store_extension`, `media_order`, `media_type_automation`, `multi_photo_to_video`, `music_generation`, `pac_relaxation`, `product_extensions`, `profile_card`, `profile_extension`, `replace_media_text`, `reveal_details_over_time`, `show_destination_blurbs`, `show_summary`, `site_extensions`, `standard_enhancements`, `standard_enhancements_catalog`, `text_extraction_for_headline`, `text_extraction_for_tap_target`, `text_optimizations`, `text_overlay_translation`, `text_translation`, `translate_voiceover`, `video_highlights`, `video_to_image`, `wa_mm_image_filtering`, `wa_mm_text_truncation_length`

(Verified 2026-09-02: exactly **46 fields**, list matches the reference character-for-character.)

> **Fact-check finding — the reference and the guide disagree, and this is load-bearing.** The 46-field `AdCreativeFeaturesSpec` reference above **does not contain** `video_auto_crop`, `video_filtering`, `video_uncrop`, `image_uncrop`, `enhance_cta`, `image_brightness_and_contrast` or `image_text_translation` — yet all seven are documented as `creative_features_spec` keys on the Advantage+ get-started guide, and the 2026-06-28 out-of-cycle change explicitly says *"Opt in to or out of this feature per creative through the `video_filtering` field in `degrees_of_freedom_spec.creative_features_spec`"* (same sentence for `video_uncrop` and `image_animation`). The v22.0 deprecation blog likewise names `video_auto_crop` as the single-video successor to `standard_enhancements`.
>
> **Conclusion:** the video keys are real and API-settable — the *reference table* is the stale surface, not the guide. But because they are not in the typed reference, **you cannot assume they validate**: send them, then read the creative back and diff (§8.3). If a key you sent is missing from the read-back, you do not know whether it was stripped for ineligibility or rejected as unknown — log both possibilities.

Descriptions from https://developers.facebook.com/docs/marketing-api/creative/advantage-creative/get-started/ (quoted):

| Key | What it does |
|---|---|
| `adapt_to_placement` | *"Opt-in if you want to automatically fit images to placements"* |
| `add_text_overlay` | *"…add information from catalog items as visually-unique overlays"* |
| `creative_stickers` | *"…add AI-generated stickers"* |
| `description_automation` | *"…item information from your catalog to be used for your ad's description"* |
| `enhance_cta` | *"…keyphrases from your ad sources to be paired with your CTA"* |
| `image_animation` | *"…a static image automatically transformed into a short animated video"* |
| `image_background_gen` | *"…different backgrounds for eligible product images"* |
| `image_brightness_and_contrast` | *"…the brightness and contrast of your image adjusted"* |
| `image_templates` | *"…overlays added that show text"* |
| `image_text_translation` | translates text inside images |
| `image_touchups` | *"…your chosen media automatically cropped and expanded"* |
| `image_uncrop` | *"…your image automatically expanded to fit more placements"* |
| `inline_comment` | *"…the most relevant comment displayed below your ad"* |
| `media_type_automation` | *"…videos from your catalog displayed"* |
| `pac_relaxation` | *"…show media for a specific aspect ratio across all placements"* |
| `product_extensions` | *"…items from your catalog shown next to your selected media"* |
| `reveal_details_over_time` | *"…information revealed when people look at your ad"* |
| `text_optimizations` | *"…text options appear as primary text, headline or description"* |
| `text_translation` | *"…your ad translated to different languages"* |
| `translate_voiceover` | *"…spoken audio automatically translated into supported languages"* |
| **`video_auto_crop`** | *"…your chosen media automatically cropped and expanded"* — **video only** |
| **`video_filtering`** | *"…a visual enhancement automatically applied to your video"* — **video only** |
| **`video_uncrop`** | *"…your video automatically expanded to fit more placements"* — **video only** |

**New as of 2026-06-28** (https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026): `image_animation`, `video_filtering` and `video_uncrop` became API-controllable via `degrees_of_freedom_spec.creative_features_spec`. `video_filtering` includes SDR→HDR conversion. If you generate video with a deliberate colour grade, **`video_filtering` will regrade it.**

### 8.3 The eligibility-stripping rule

> *"Features specified as `OPT_IN` but ineligible for the given ad setup will be automatically removed from the `creative_features_spec` parameter."*

**Gotcha #14:** Meta silently **deletes** ineligible keys from your submitted spec. Your write is not your read. **Always `GET` the creative back and diff `degrees_of_freedom_spec.creative_features_spec` against what you sent**, and store the read-back version as the record of what is actually running. An optimizer that reasons over the requested spec rather than the effective spec will draw wrong conclusions about what changed between variants.

### 8.4 Brand-control recipe

There is **no master off-switch** any more. To hold a generated video exactly as rendered, opt out of each transforming feature explicitly:

```json
"degrees_of_freedom_spec": { "creative_features_spec": {
  "video_auto_crop":     { "enroll_status": "OPT_OUT" },
  "video_uncrop":        { "enroll_status": "OPT_OUT" },
  "video_filtering":     { "enroll_status": "OPT_OUT" },
  "image_animation":     { "enroll_status": "OPT_OUT" },
  "image_touchups":      { "enroll_status": "OPT_OUT" },
  "image_uncrop":        { "enroll_status": "OPT_OUT" },
  "image_templates":     { "enroll_status": "OPT_OUT" },
  "add_text_overlay":    { "enroll_status": "OPT_OUT" },
  "replace_media_text":  { "enroll_status": "OPT_OUT" },
  "text_optimizations":  { "enroll_status": "OPT_OUT" },
  "description_automation": { "enroll_status": "OPT_OUT" },
  "generate_cta":        { "enroll_status": "OPT_OUT" },
  "enhance_cta":         { "enroll_status": "OPT_OUT" },
  "creative_stickers":   { "enroll_status": "OPT_OUT" },
  "music_generation":    { "enroll_status": "OPT_OUT" },
  "translate_voiceover": { "enroll_status": "OPT_OUT" },
  "text_translation":    { "enroll_status": "OPT_OUT" },
  "inline_comment":      { "enroll_status": "OPT_OUT" },
  "adapt_to_placement":  { "enroll_status": "OPT_OUT" },
  "pac_relaxation":      { "enroll_status": "OPT_OUT" },
  "video_highlights":    { "enroll_status": "OPT_OUT" },
  "video_to_image":      { "enroll_status": "OPT_OUT" },
  "multi_photo_to_video":{ "enroll_status": "OPT_OUT" },
  "profile_card":        { "enroll_status": "OPT_OUT" },
  "standard_enhancements": { "enroll_status": "OPT_OUT" }
}}
```
(Keep `standard_enhancements: OPT_OUT` for older-version compatibility; it is a no-op on v22.0+ writes but harmless.)

**Default-on warning:** secondary sources report that since **February 2026** all new Sales / Leads / App Promotion campaigns launch with every Advantage+ Creative enhancement enabled by default (https://adsuploader.com/blog/advantage-plus-creative-enhancements , https://leapbuzz.com/blog/meta-advantage-plus-creative-ai/). I could not confirm this in official docs — **UNVERIFIED** — but the design implication is one-directional and cheap: **always send an explicit `creative_features_spec` on every creative**, never rely on defaults.

**The A/B question this creates:** for a self-improving system, Advantage+ enhancements are a confounder. Two ads with identical assets can be rendered differently by Meta. Either (a) opt out of everything so your experiment measures your creative, or (b) opt in uniformly across all arms and treat "Meta's transform" as a fixed part of the environment. Mixing the two invalidates the comparison.

---

## 9. Current creative specs per placement (as of 2026-09-02)

All figures below are quoted from Meta's Ads Guide (`facebook.com/business/ads-guide/update/...`), which is the authoritative advertiser-facing spec sheet. **These pages are objective-scoped** — the URL pattern is `/business/ads-guide/update/<format>/<placement>[/<objective>]`, and text limits differ per objective.

| Placement (API position) | Ratio | Recommended res | Duration | Max size | Primary text | Headline | Source |
|---|---|---|---|---|---|---|---|
| **Facebook Feed** (`facebook:feed`) | 4:5 | 1440 × 1800 | 1 s – 241 min | 4 GB | 50–150 chars | 27 chars | https://www.facebook.com/business/ads-guide/video/facebook-feed |
| **Instagram Feed** (`instagram:stream`) | 9:16 *(see note)* | 1080 × 1920 | 1 s – 60 min | 4 GB | 125 chars | — | https://www.facebook.com/business/ads-guide/update/video/instagram-feed |
| **Instagram Reels** (`instagram:reels`) | 9:16 | 1440 × 2560 | 0 s – 15 min | 4 GB | 44 chars | — | https://www.facebook.com/business/ads-guide/update/video/instagram-reels |
| **Instagram Stories** (`instagram:story`) | 9:16 | 1440 × 2560 | 1 s – 60 min | 4 GB | 125 chars | — | https://www.facebook.com/business/ads-guide/update/video/instagram-story |
| **Facebook Reels** (`facebook:facebook_reels`) | 9:16 | 1440 × 2560 | no max stated | 4 GB | 40 chars | 55 chars | https://www.facebook.com/business/ads-guide/update/video/facebook-facebook-reels |
| **Facebook Reels overlay / post-loop** (`facebook:facebook_reels_overlay`) | **1:1** | 1440 × 1440 | **4–15 s** | 4 GB | 60 chars | — | https://www.facebook.com/business/ads-guide/update/video/facebook-facebook-reels-overlay |
| **Facebook Stories** (`facebook:story`) | 9:16 | 1440 × 2560 | **1 s – 3 min** | 4 GB | 125 chars | 40 chars | https://www.facebook.com/business/ads-guide/update/video/facebook-story |

Shared across all of the above: file types **MP4 / MOV** (Feed and Stories also accept **GIF**); *"H.264 compression, square pixels, fixed frame rate, progressive scan and stereo AAC audio compression at 128kbps+"*; *"Videos should not contain edit lists or special boxes in file containers."*

**Minimum width rules** (Reels/Stories pages): **250 px** for videos under 30 s; **500 px** for videos 30 s and over. **Aspect ratio tolerance: 1%.**

**Note on Instagram Feed:** the current Awareness-objective page states ratio **9:16 at 1080 × 1920** for IG Feed video — Meta has pushed Feed toward vertical. The older "Video requirements chart" (https://www.facebook.com/business/m/one-sheeters/video-requirements) still says IG Feed is *"1.91:1 to 4:5"*, lists Messenger Stories (removed in v26.0), and gives FB Stories as 1–120 s against the current page's 1–3 min. **That one-sheeter is stale — do not use it.**

### 9.1 Safe zones (text/logo margins)

Two different numbers appear in Meta's own docs:

- **Instagram Reels, Instagram Stories, Facebook Reels ad pages:** keep *"at least 14% of the top, 35% of the bottom, and 6% on each side"* free from text, logos, and key creative elements.
- **Facebook Stories page (and Meta's Stories/Reels safe-zone help article):** *"approximately 14% (250 pixels) at the top and 20% (340 pixels) at the bottom."*

**Design rule for the generator: use the stricter set — 14% top, 35% bottom, 6% each side.** On a 1080 × 1920 canvas that is a text-safe box of roughly **x ∈ [65, 1015], y ∈ [269, 1248]** (950 × 979 px). Anything outside is at risk of being covered by the profile row, caption, CTA button or the Reels action rail. A 35% bottom margin is aggressive but it is what Meta's Reels pages specify, and it is exactly where the CTA sheet sits.

### 9.2 Text truncation

The character counts above are **recommended display limits, not API limits**. API limits are much larger (`asset_feed_spec` bodies allow 1024 chars, titles/descriptions 255). Exceeding the display limit does not error — it **truncates with an ellipsis and a "See more" affordance**, which on Reels/Stories means your copy is simply not read. For an automated copy generator, treat these as hard constraints:

| Field | Budget |
|---|---|
| Primary text (`message` / `bodies[].text`) | **40 chars** if the ad may serve on Facebook Reels; **44** for IG Reels; **125** if Feed/Stories only |
| Headline (`title` / `titles[].text`) | **27 chars** for FB Feed; 40 for FB Stories; 55 for FB Reels |
| Description (`link_description` / `descriptions[].text`) | Rarely rendered on video placements; ≤ 30 chars if used |

Since one ad usually spans several placements, **generate to the minimum across the placement set** (i.e. 40-char primary text / 27-char headline for a cross-placement video ad), or use placement asset customization with `body_label` / `title_label` to ship per-placement copy.

---

## 10. Call-to-action enum

Complete `type` enum from https://developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data-call-to-action/ :

```
OPEN_LINK, LIKE_PAGE, SHOP_NOW, PLAY_GAME, INSTALL_APP, USE_APP, CALL, CALL_ME,
VIDEO_CALL, INSTALL_MOBILE_APP, USE_MOBILE_APP, MOBILE_DOWNLOAD, BOOK_TRAVEL,
LISTEN_MUSIC, WATCH_VIDEO, LEARN_MORE, SIGN_UP, DOWNLOAD, WATCH_MORE, NO_BUTTON,
VISIT_PAGES_FEED, CALL_NOW, APPLY_NOW, CONTACT, BUY_NOW, GET_OFFER,
GET_OFFER_VIEW, BUY_TICKETS, UPDATE_APP, GET_DIRECTIONS, BUY, SEND_UPDATES,
MESSAGE_PAGE, DONATE, SUBSCRIBE, SAY_THANKS, SELL_NOW, SHARE, DONATE_NOW,
GET_QUOTE, CONTACT_US, ORDER_NOW, START_ORDER, ADD_TO_CART, VIEW_CART,
VIEW_IN_CART, VIDEO_ANNOTATION, RECORD_NOW, INQUIRE_NOW, CONFIRM, REFER_FRIENDS,
REQUEST_TIME, GET_SHOWTIMES, LISTEN_NOW, TRY_DEMO, WOODHENGE_SUPPORT,
SOTTO_SUBSCRIBE, FOLLOW_USER, RAISE_MONEY, SEE_SHOP, GET_DETAILS, FIND_OUT_MORE,
VISIT_WEBSITE, BROWSE_SHOP, EVENT_RSVP, WHATSAPP_MESSAGE, FOLLOW_NEWS_STORYLINE,
SEE_MORE, BOOK_NOW, FIND_A_GROUP, FIND_YOUR_GROUPS, PAY_TO_ACCESS,
PURCHASE_GIFT_CARDS, FOLLOW_PAGE, SEND_A_GIFT, SWIPE_UP_SHOP, SWIPE_UP_PRODUCT,
SEND_GIFT_MONEY, PLAY_GAME_ON_FACEBOOK, GET_STARTED, OPEN_INSTANT_APP,
AUDIO_CALL, GET_PROMOTIONS, JOIN_CHANNEL, MAKE_AN_APPOINTMENT,
ASK_ABOUT_SERVICES, BOOK_A_CONSULTATION, GET_A_QUOTE, BUY_VIA_MESSAGE,
ASK_FOR_MORE_INFO, CHAT_WITH_US, VIEW_PRODUCT, VIEW_CHANNEL, GET_IN_TOUCH,
ASK_A_QUESTION, START_A_CHAT, CHAT_NOW, ASK_US, WATCH_LIVE_VIDEO,
JOIN_LIVE_VIDEO, SHOP_WITH_AI, TRY_ON_WITH_AI
```
(`SHOP_WITH_AI` and `TRY_ON_WITH_AI` are recent additions — worth noting as an AI-commerce surface.)

### 10.1 CTA availability by objective

**UNVERIFIED at the enum level.** Meta documents this only in the Business Help Center (https://www.facebook.com/business/help/410873986524407), which is client-rendered and could not be scraped; the API reference publishes one flat enum with no per-objective mapping, and validation happens server-side at ad-creation time.

Practical, low-risk defaults that are safe across objectives for a **website-destination video ad**:

| Objective | Safe CTA choices |
|---|---|
| `OUTCOME_AWARENESS` | `LEARN_MORE`, `WATCH_MORE`, `NO_BUTTON` |
| `OUTCOME_TRAFFIC` | `LEARN_MORE`, `SHOP_NOW`, `BOOK_NOW`, `DOWNLOAD`, `GET_OFFER` |
| `OUTCOME_ENGAGEMENT` | `LEARN_MORE`, `LIKE_PAGE`, `MESSAGE_PAGE`, `WHATSAPP_MESSAGE` |
| `OUTCOME_LEADS` | `SIGN_UP`, `APPLY_NOW`, `GET_QUOTE`, `SUBSCRIBE`, `CONTACT_US`, `BOOK_NOW` |
| `OUTCOME_SALES` | `SHOP_NOW`, `BUY_NOW`, `ORDER_NOW`, `ADD_TO_CART`, `GET_OFFER` |
| `OUTCOME_APP_PROMOTION` | `INSTALL_APP`, `USE_APP`, `PLAY_GAME`, `DOWNLOAD` |

**Engineering approach for an autonomous system:** do not attempt to pre-validate. Submit, catch **error 100** on `call_to_action.type`, and fall back to `LEARN_MORE`, which is accepted by every website-destination objective. Cache the (objective, conversion location) → accepted-CTA mapping you discover empirically per ad account.

---

## 11. Ad preview / QA before going live

Two endpoints; use the first for pre-flight QA on a creative spec that has no ad yet, the second for an existing ad.

```
GET /v26.0/act_<AD_ACCOUNT_ID>/generatepreviews
      ?ad_format=INSTAGRAM_REELS
      &creative={"object_story_spec":{...}}        # full inline spec OR {"creative_id":"..."}
      &access_token=<TOKEN>

GET /v26.0/<AD_ID>/previews?ad_format=MOBILE_FEED_STANDARD
```
Docs: https://developers.facebook.com/docs/marketing-api/reference/ad-account/generatepreviews/ , https://developers.facebook.com/docs/marketing-api/generatepreview/

**Response** is `{"data":[{"body":"<iframe src=\"https://www.facebook.com/ads/api/preview_iframe.php?d=...\" width=\"274\" height=\"213\" ...></iframe>"}]}` — an HTML **iframe string**, not an image. To capture a PNG for automated visual QA you must render it headlessly (Playwright/Puppeteer) — there is no server-side image endpoint.

**Visibility rule (verbatim):** *"Previews from an ad account are only visible to people who have a role on the ad account. Previews generated using `generatepreviews` edge are visible to anyone."* So `/generatepreviews` output can be shared with an end-customer for approval; `/{ad_id}/previews` output cannot.

**Optional params:** `height`, `width` (*"minimum 280×280 recommended"*), `locale`, `post`, `place_page_id`, `product_item_ids`, `dynamic_creative_spec`, `dynamic_customization`, `start_date`/`end_date`, and `dynamic_asset_label` — **`dynamic_asset_label` is how you preview a specific asset-customization variant**, and `creative_feature` (values `ig_video_native_subtitle`, `image_animation`, `product_browsing`, `product_metadata_automation`, `profile_card`, `standard_enhancements_catalog`, `text_overlay_translation`) lets you preview with a specific enhancement applied.

**Complete `ad_format` enum** (verbatim from the reference):
```
AUDIENCE_NETWORK_INSTREAM_VIDEO, AUDIENCE_NETWORK_INSTREAM_VIDEO_MOBILE,
AUDIENCE_NETWORK_OUTSTREAM_VIDEO, AUDIENCE_NETWORK_REWARDED_VIDEO,
BIZ_DISCO_FEED_MOBILE, DESKTOP_FEED_STANDARD, FACEBOOK_IFU_REELS_MOBILE,
FACEBOOK_PROFILE_FEED_DESKTOP, FACEBOOK_PROFILE_FEED_MOBILE,
FACEBOOK_PROFILE_REELS_MOBILE, FACEBOOK_REELS_BANNER,
FACEBOOK_REELS_BANNER_DESKTOP, FACEBOOK_REELS_BANNER_FEED_ANDROID,
FACEBOOK_REELS_BANNER_FEED_ANDROID_LARGE, FACEBOOK_REELS_BANNER_FULLSCREEN_IOS,
FACEBOOK_REELS_BANNER_FULLSCREEN_MOBILE, FACEBOOK_REELS_MOBILE,
FACEBOOK_REELS_POSTLOOP, FACEBOOK_REELS_POSTLOOP_FEED,
FACEBOOK_REELS_SIMILAR_PRODUCTS_MOBILE, FACEBOOK_REELS_STICKER,
FACEBOOK_STORY_MOBILE, FACEBOOK_STORY_STICKER_MOBILE,
INSTAGRAM_EXPLORE_CONTEXTUAL, INSTAGRAM_EXPLORE_GRID_HOME,
INSTAGRAM_EXPLORE_IMMERSIVE, INSTAGRAM_FEED_WEB, INSTAGRAM_FEED_WEB_M_SITE,
INSTAGRAM_LEAD_GEN_MULTI_SUBMIT_ADS, INSTAGRAM_PROFILE_FEED,
INSTAGRAM_PROFILE_REELS, INSTAGRAM_REELS, INSTAGRAM_REELS_OVERLAY,
INSTAGRAM_REELS_WEB, INSTAGRAM_REELS_WEB_M_SITE, INSTAGRAM_SEARCH_CHAIN,
INSTAGRAM_SEARCH_GRID, INSTAGRAM_STANDARD, INSTAGRAM_STORY,
INSTAGRAM_STORY_EFFECT_TRAY, INSTAGRAM_STORY_WEB, INSTAGRAM_STORY_WEB_M_SITE,
INSTANT_ARTICLE_RECIRCULATION_AD, INSTANT_ARTICLE_STANDARD,
INSTREAM_BANNER_DESKTOP, INSTREAM_BANNER_FEED_IOS,
INSTREAM_BANNER_FULLSCREEN_IOS, INSTREAM_BANNER_FULLSCREEN_MOBILE,
INSTREAM_BANNER_IMMERSIVE_MOBILE, INSTREAM_BANNER_MOBILE,
INSTREAM_VIDEO_DESKTOP, INSTREAM_VIDEO_FULLSCREEN_IOS,
INSTREAM_VIDEO_FULLSCREEN_MOBILE, INSTREAM_VIDEO_IMAGE,
INSTREAM_VIDEO_IMMERSIVE_MOBILE, INSTREAM_VIDEO_MOBILE, JOB_BROWSER_DESKTOP,
JOB_BROWSER_MOBILE, MARKETPLACE_MOBILE, MESSENGER_MOBILE_INBOX_MEDIA,
MESSENGER_MOBILE_STORY_MEDIA, MOBILE_BANNER, MOBILE_FEED_BASIC,
MOBILE_FEED_STANDARD, MOBILE_FULLWIDTH, MOBILE_INTERSTITIAL,
MOBILE_MEDIUM_RECTANGLE, MOBILE_NATIVE, RIGHT_COLUMN_STANDARD,
SUGGESTED_VIDEO_DESKTOP, SUGGESTED_VIDEO_FULLSCREEN_MOBILE,
SUGGESTED_VIDEO_IMMERSIVE_MOBILE, SUGGESTED_VIDEO_MOBILE, WATCH_FEED_HOME,
WATCH_FEED_MOBILE, WHATSAPP_STATUS_MEDIA
```
**QA set for a vertical video ad:** `INSTAGRAM_REELS`, `INSTAGRAM_STORY`, `FACEBOOK_REELS_MOBILE`, `FACEBOOK_STORY_MOBILE`, `MOBILE_FEED_STANDARD`, `INSTAGRAM_STANDARD`, `FACEBOOK_REELS_POSTLOOP`.

**Error codes:** 100 (invalid parameter), 194 (missing required parameter), 200 (permissions), 1500 (*"Invalid URL supplied"* — usually a bad `call_to_action.value.link`), 80004 (rate limit), 2635 (deprecated API version).

**Preview iframe lifetime: UNVERIFIED.** The `preview_iframe.php?d=` payload is a signed token and is widely observed to expire, but Meta publishes no TTL. **Do not persist preview iframes as durable artefacts** — screenshot them at generation time and store the PNG.

**Gotcha #15:** `/generatepreviews` renders the creative spec, **not the delivery**. It will happily render an `INSTAGRAM_REELS` preview for a creative whose ad set excludes Instagram. Preview coverage is not placement coverage; check the ad set's effective placements separately.

---

## 12. Tracking — `url_tags`, per-asset tags, `tracking_specs`

### 12.1 `url_tags`

A creative-level query string appended to every outbound click URL. Set on `POST /act_{id}/adcreatives` as `url_tags` (https://developers.facebook.com/docs/marketing-api/reference/ad-creative/). It is the API equivalent of Ads Manager's "URL parameters" field, which lives **on the ad, not the campaign or ad set**.

**Format:** `key=value&key=value` — **no leading `?`**.

**Dynamic macros** Meta substitutes at click time (per https://www.facebook.com/business/help/2360940870872492 , summarised in secondary sources since the help page is client-rendered):
`{{ad.id}}`, `{{ad.name}}`, `{{adset.id}}`, `{{adset.name}}`, `{{campaign.id}}`, `{{campaign.name}}`, `{{site_source_name}}`, `{{placement}}`.

- `{{site_source_name}}` resolves to `fb` (Facebook), `ig` (Instagram), `msg` (Messenger), `an` (Audience Network).
- `{{placement}}` resolves to a placement name such as `Feed`, `Stories`, `Instant Article`, `Right Column`.

Recommended string for an automated pipeline (IDs are stable, names are not):
```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_id={{campaign.id}}&fb_adid={{ad.id}}&fb_adsetid={{adset.id}}&fb_placement={{placement}}&fb_source={{site_source_name}}
```

**Gotcha #16:** with Dynamic Creative / flexible format, Meta recombines assets per impression, so an ad-name-derived `utm_content` no longer identifies *which creative* was shown. Use **`asset_feed_spec.videos[].url_tags`** (per-asset URL tags — see §6.1) to attribute at the asset level, and/or read Insights with `breakdowns=video_asset,body_asset,title_asset`.

**Gotcha #17:** if your landing page URL already contains a query string, Meta appends `url_tags` with `&`. If it contains a fragment (`#`), the appended params can land after the fragment and be invisible to server-side analytics. Normalise destination URLs to have no fragment.

### 12.2 `tracking_specs`

Docs: https://developers.facebook.com/docs/marketing-api/tracking-specs/

- **Tracking specs** record actions for reporting; they do **not** affect delivery.
- **Conversion specs** drive optimisation and have been *"read-only since v2.4"* — derived from `optimization_goal`. **You cannot set `conversion_specs`.** Set `optimization_goal` + `promoted_object` instead.
- Shape: `{'action.type': 'ACTION', <object-field>: <id>}`.
- Common `action.type` values: `offsite_conversion`, `post_engagement`, `link_click`, `app_custom_event`, `rsvp`, `like`.
- Object fields: `fb_pixel`, `application`, `page`, `post`, `offer`.

Example (track all pixel conversions on an ad, regardless of the optimisation event):
```json
"tracking_specs": [{ "action.type": ["offsite_conversion"], "fb_pixel": ["<PIXEL_ID>"] }]
```

**Gotcha #18:** *"For `APP_INSTALLS` or `OUTCOME_ENGAGEMENT` objectives, Meta overwrites the default tracking specs."* For every other objective/creative combination *"default tracking specs are still available and Meta does not overwrite them."*

*(Fact-check refinement 2026-09-02: the draft said custom specs are "silently replaced" — that overstates it. What the doc says is that Meta overwrites the **default** specs on these objectives, so **if you want the defaults you must add them yourself to your custom spec list**. Your custom entries survive; the implicit defaults do not.)*

---

## 13. AI-generated video creative — current Meta rules

This is the area where blog coverage is most divergent from Meta's actual published policy. Here is what is **verified**, and what is **not**.

### 13.1 Verified: political / social-issue ads must self-disclose

From Meta's Transparency Center, Ads about Social Issues, Elections or Politics (https://transparency.meta.com/policies/ad-standards/SIEP-advertising/SIEP/):

> *"Advertisers must also disclose when a social issue, elections, or political ad contains a photorealistic image or video, or realistic sounding audio, that was created or edited using third-party generative AI tools to"* — depict a real person saying or doing something they did not; depict a realistic-looking person who does not exist or a realistic-looking event that did not happen or alter footage of a real event; or depict a realistic event that allegedly occurred but is not a true recording of it.

> If Meta determines an advertiser has not disclosed as required, Meta will *"reject the ad, and repeated failure to disclose may result in penalties against the advertiser."*

**API surface:** `AdCreative.authorization_category`, whose enum includes **`POLITICAL`** and **`POLITICAL_WITH_DIGITALLY_CREATED_MEDIA`** (https://developers.facebook.com/docs/marketing-api/reference/ad-creative/). The second value is the machine-readable form of this disclosure. Any SIEP ad in this platform that uses generated video **must** set `authorization_category = "POLITICAL_WITH_DIGITALLY_CREATED_MEDIA"`, and the advertiser must have completed identity/location authorisation first.

### 13.2 Verified: automated detection and the "AI info" label

From https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/ (announced 2025-02-03, updated for 2026-06-01):

> *"We will also begin automatically detecting ads created or edited using third-party AI tools through industry-standard signals."*

Detected ads receive an **"AI info" label** surfaced in the **"About this ad"** panel. Placement of the label varies: it sits behind the three-dot menu normally, but *"When AI-generated photorealistic humans are included, the label will appear next to the Sponsored label (not behind the three-dot menu)."*

**Beginning 2026-06-01, Meta uses automated detection technology** to identify ad media created or edited with third-party generative AI tools — this is independent of, and in addition to, advertiser self-disclosure.

**Direct engineering consequence:** "industry-standard signals" means **C2PA / IPTC content credentials and provenance metadata embedded by the generator**. Most commercial video generators embed these. So:
1. **Assume every AI-generated video you upload will be detected and labelled.** Design the product around that, not around evading it.
2. **Do not strip provenance metadata** to avoid the label. Stripping C2PA is not a documented violation, but it is adversarial to a detection system Meta enforces on, and the downside (account-level penalties) is asymmetric.
3. Photorealistic synthetic humans get the **most prominent** label placement — next to "Sponsored". If the creative strategy depends on a synthetic spokesperson looking authentic, that assumption is wrong on Meta as of June 2026.

### 13.3 NOT verified: a universal AI-disclosure requirement for all ads

Numerous 2026 SEO blogs claim Meta now requires **every** advertiser to tick an "AI-generated" box in Ads Manager for any AI-assisted creative, and that missing it is a top rejection reason (e.g. https://www.cinerads.com/blog/ai-ugc-facebook-ad-policy , https://jdesigns.info/blog/meta-ai-disclosure-rules-2026 , https://dhruboduti.com/blog/ai-generated-ad-creative-now-requires-disclosure-on-meta-what-counts-and-how-to-comply).

**I could not confirm this in any Meta primary source.** Every official page I could reach scopes the *mandatory disclosure* to **social issues, elections and politics** ads only; for everything else Meta describes what **Meta** labels (automatically), not what the advertiser must declare. There is also **no documented API field** for a general (non-political) AI disclosure — `authorization_category` is political-only.

**Status: UNVERIFIED. Where official docs and blogs contradict, the docs win.**
**Design implication:** build the disclosure field into the data model anyway (`creative.ai_generated: bool`, `creative.ai_photorealistic_human: bool`) and wire it to `authorization_category` for SIEP ads today. If Meta later ships a general disclosure field, you set it from data you already have rather than backfilling.

### 13.4 Adjacent rules that bite AI video

- **Music:** Instagram will not promote Reels using copyrighted music. Meta's June 2026 audio-swap parameters on `/advideos` exist specifically for this (§1.2). Generate with Meta Sound Collection tracks or synthetic/licensed audio.
- **`music_generation`, `creative_stickers`, `image_background_gen`, `translate_voiceover`** are all Advantage+ features that will add *further* AI generation on top of yours unless opted out (§8.4). An ad can end up with a Meta-generated voiceover translation over your generated video.
- Every Reels ads-guide page lists content restrictions: *avoid licensed music, face/camera effects, GIFs, product tags,* and *videos with edit lists or special boxes*.

---

## 14. Gotchas — consolidated

1. **`graph-video.facebook.com` is deprecated.** Use `graph.facebook.com` for uploads.
2. **`start` returns a `video_id` before the asset is usable.** Gate on `status.video_status == "ready"`.
3. **Chunk sizes are dictated by Meta**, returned in each `transfer` response. Loop until `start_offset == end_offset`.
4. **There is no offset-query call on `/advideos`.** Persist `upload_session_id` + offset yourself or lose the upload on worker restart.
5. **`act_` prefix in the path; never `ad_account_id` in the body.**
6. **`video_data` has no `link` field.** The destination lives in `call_to_action.value.link`, and it *"is required to be same as the link url of the creative."*
7. **`instagram_actor_id` no longer exists** — use `instagram_user_id`. Legacy stored ids are legacy *objects* and will not work.
8. **Three names for one thumbnail:** `video_data.image_hash`, `asset_feed_spec.videos[].thumbnail_hash`, `creative_asset_groups_spec.groups[].videos[].image_hash`.
9. **`/adimages` response is keyed by your multipart field name**, not a constant.
10. **Placement asset customization requires ≥ 2 rules.** One rule always errors.
11. **`is_default` is multi-language-only** — there is no default rule for placement customization; enumerate exhaustively.
12. **Meta silently strips ineligible `creative_features_spec` keys.** Read the creative back and diff.
13. **There is no master Advantage+ off-switch** since v22.0. Opt out feature-by-feature, on every creative.
14. **Dynamic Creative locks the ad set:** one ad per ad set, ad set must be empty at creation, and you must delete the *ad set* to remove the ad.
15. **Don't set both `object_story_spec.video_data` and `asset_feed_spec`.** With an asset feed, `object_story_spec` is identity-only.
16. **Placement enum tables disagree across Meta's own docs.** Don't hard-code; read back `effective_*` fields.
17. **Ads-guide specs are objective-scoped.** `/video/instagram-reels` (Awareness) and `/video/instagram-reels/outcome-leads` are different pages; primary-text limits differ.
18. **The `facebook_reels_overlay` placement is 1:1 and 4–15 s** — a 9:16 master will not serve there correctly.
19. **Meta's "Video requirements chart" one-sheeter is stale** (lists Messenger Stories, removed in v26.0).
20. **`conversion_specs` is read-only since v2.4.** Set `optimization_goal` + `promoted_object`.
21. **Custom `tracking_specs` are overwritten** for `APP_INSTALLS` and `OUTCOME_ENGAGEMENT`.
22. **Preview ≠ delivery.** `/generatepreviews` renders any `ad_format` regardless of the ad set's placements.
23. **`/generatepreviews` output is public; `/{ad_id}/previews` output requires an ad-account role.**
24. **Preview iframes are signed and expire (TTL undocumented).** Screenshot immediately.
25. **v26.0 silently removes `messenger_positions: story`** — no error, just a different effective placement set.
26. **AI-generated video will be auto-detected and labelled** from 2026-06-01; photorealistic synthetic humans get the most prominent label.
27. **The public `Video` node reference no longer lists `status`.** The field works; the doc was trimmed. Don't infer removal from doc omission.
28. **Error 352 / 6000 on upload are almost always encoder problems** — non-4:2:0 pixel format, moov atom at the end, or edit lists in the container. Normalise with `-pix_fmt yuv420p -movflags +faststart`.

---

## 15. Open questions / UNVERIFIED

| # | Question | Why it matters | Status |
|---|---|---|---|
| 1 | Is a general (non-political) AI-disclosure **required** of advertisers, and is there an API field for it? | Determines whether every generated creative needs a declaration | **UNVERIFIED** — blogs say yes, no Meta primary source found; `authorization_category` is political-only |
| 2 | Can `/act_{id}/advideos` accept a Resumable Upload API file handle (`h`)? | Would let one upload path serve images + video | **UNVERIFIED** — undocumented; assume no |
| 3 | Exact processing SLA / typical latency for `video_status: ready` | Sets pipeline timeout budget | **UNVERIFIED** — no published SLA |
| 4 | TTL of the `preview_iframe.php` signed token | Whether preview links can be shared for human approval | **UNVERIFIED** |
| 5 | Is `POST /{page_id}/page_backed_instagram_accounts` idempotent? | Duplicate-PBIA risk on retry | **UNVERIFIED** — implement GET-then-POST |
| 6 | Does `is_preferred` on `/{video_id}/thumbnails` affect ad rendering for `advideos`-uploaded assets? | Whether you can skip `/adimages` | **UNVERIFIED** — use `image_hash` instead |
| 7 | Is `instagram_positions: explore` / `explore_home` still valid after v26.0 removed "Instagram Explore Feed"? | Placement rules will 400 | **CONTRADICTORY** — changelog vs placement-targeting reference |
| 8 | Behaviour when an ad-set placement matches no `asset_customization_rule` | Silent placement loss | **UNVERIFIED** |
| 9 | Shapes of `generative_asset_spec`, `creative_sourcing_spec`, `media_sourcing_spec`, `format_transformation_spec`, `contextual_multi_ads` | Possibly the future first-class API for AI creative | **UNVERIFIED** — present on the node, undocumented |
| 10 | Full `selected_audio_spec` shape for the June 2026 IG audio swap | Music compliance automation | **UNVERIFIED** — announced in OCC, reference not published |
| 11 | Per-objective CTA validity mapping | Avoiding error 100 on submit | **UNVERIFIED** — Help Center only; discover empirically |
| 12 | Whether Advantage+ enhancements are default-ON for new Sales/Leads/App campaigns since Feb 2026 | Brand safety of un-specified creatives | **UNVERIFIED** — secondary sources only; mitigate by always sending explicit spec |
| 13 | True hard limit for ad video file size — 4 GB (ads guide) vs 1 GB (app-ads page) | Upload budget | **CONTRADICTORY** — use 4 GB for ad placements, keep renders ≪ that |
| 14 | Reels ads maximum duration (ads guide says 15 min for IG Reels; no max stated for FB Reels) | Generator length budget | **Documented but implausible** — keep generated Reels ≤ 60 s regardless |

---

## 16. Implementation checklist for the automated pipeline

1. **Render** master at 9:16 1080×1920, H.264 High, yuv420p, fixed 30 fps, closed GOP 2 s, AAC 128 kbps 48 kHz stereo, `+faststart`, no edit lists. Derive 4:5 and 1:1 crops.
2. **Compose copy** to the minimum cross-placement budget (primary ≤ 40, headline ≤ 27) and keep all burned-in text inside the 14%/35%/6% safe box.
3. **Upload** each cut via `advideos` chunked upload; persist `upload_session_id` + offset per chunk; `cancel` on abort.
4. **Poll** `GET /{video_id}?fields=status` with capped backoff to `ready`; hard-fail at 15 min.
5. **Poster:** extract a frame per cut at matching AR; upload via `/adimages`; keep the `hash`.
6. **Identity:** resolve `instagram_user_id`; create a PBIA if the Page has none; cache per Page.
7. **Creative:** `object_story_spec{page_id, instagram_user_id}` + `asset_feed_spec` with labelled videos + `asset_customization_rules` (≥ 2) + `optimization_type: "PLACEMENT"`; plus explicit `degrees_of_freedom_spec` opt-outs; plus `url_tags`.
8. **Read back** the creative and diff `creative_features_spec` and `effective_*` fields; store the effective spec as the experiment record.
9. **QA:** `/act_{id}/generatepreviews` across the 7-format QA set; headless-screenshot each iframe; store PNGs.
10. **Ship** the ad `PAUSED`, verify, then activate.
11. **Disclosure:** set `authorization_category` for SIEP ads; record `ai_generated` flags on every creative regardless.

---

## Appendix — source index

- Graph/Marketing API changelog & versions — https://developers.facebook.com/docs/graph-api/changelog , https://developers.facebook.com/docs/graph-api/changelog/version26.0/
- 2026 out-of-cycle changes — https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026
- `advideos` reference — https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/ (mirror: https://www.withone.ai/knowledge/meta/conn_mod_def::GKRjtRsW_dY::-DzRZc5aRdCUjqK0XPw4fQ )
- Video API getting started / publishing — https://developers.facebook.com/docs/video-api/getting-started/ , https://developers.facebook.com/docs/video-api/guides/publishing , https://developers.facebook.com/docs/video-api/guides/reels-publishing
- Resumable Upload API — https://developers.facebook.com/docs/graph-api/guides/upload
- Thumbnails — https://developers.facebook.com/docs/graph-api/reference/video/thumbnails/
- `adimages` — https://developers.facebook.com/docs/marketing-api/reference/ad-account/adimages/
- AdCreative — https://developers.facebook.com/docs/marketing-api/reference/ad-creative/
- object_story_spec — https://developers.facebook.com/docs/marketing-api/reference/ad-creative-object-story-spec/
- AdCreativeVideoData — https://developers.facebook.com/docs/marketing-api/reference/ad-creative-video-data/
- CTA type / value — https://developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data-call-to-action/ , https://developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data-call-to-action-value/
- Video ads quickstart — https://developers.facebook.com/docs/marketing-api/guides/videoads/
- Instagram field migration — https://developers.facebook.com/blog/post/2025/08/11/instagram-marketing-api-update/ , https://ppc.land/meta-simplifies-instagram-and-marketing-api-integrations/
- PBIA — https://developers.facebook.com/ads/blog/post/v2/2015/12/16/ig-accounts/ , https://developers.facebook.com/docs/graph-api/changelog/version9.0
- asset_feed_spec — https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/ , .../options/ , https://developers.facebook.com/docs/marketing-api/reference/ad-asset-feed-spec/ , .../ad-asset-feed-spec-video/ , .../ad-asset-feed-spec-asset-customization-rule/
- Dynamic Creative — https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/dynamic-creative/
- Placement asset customization — https://developers.facebook.com/documentation/ads-commerce/marketing-api/dynamic-creative/placement-asset-customization , https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/asset-feed-spec/asset-customization-rules
- Flexible ad format — https://developers.facebook.com/documentation/ads-commerce/marketing-api/flexible-ad-format
- Advantage+ Creative — https://developers.facebook.com/docs/marketing-api/creative/advantage-creative/get-started/ , https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/ , https://developers.facebook.com/docs/marketing-api/reference/ad-creative-degrees-of-freedom-spec/ , https://developers.facebook.com/blog/post/2025/01/17/marketing-api-v22-impacts-to-advantage-plus-creative-enhancements/
- Placement targeting enum — https://developers.facebook.com/docs/marketing-api/audiences/reference/placement-targeting/
- Previews — https://developers.facebook.com/docs/marketing-api/reference/ad-account/generatepreviews/ , https://developers.facebook.com/docs/marketing-api/generatepreview/ , https://developers.facebook.com/docs/marketing-api/reference/ad-preview/
- Tracking specs — https://developers.facebook.com/docs/marketing-api/tracking-specs/
- Placement creative specs — https://www.facebook.com/business/ads-guide/update/ (per-placement pages cited inline)
- AI policy — https://transparency.meta.com/policies/ad-standards/SIEP-advertising/SIEP/ , https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/


---

## Fact-check log

**Adversarial re-verification pass — 2026-09-02.** Every claim below was re-checked against a Meta primary source fetched on that date. Verdicts: **15 CONFIRMED, 1 REFUTED, 2 CONFIRMED-with-material-caveats.** Corrections are applied inline above, each marked *"Fact-check"*.

### Verdicts

| # | Claim | Verdict | Primary source |
|---|---|---|---|
| 1 | v26.0 is latest, released 2026-07-29; v25.0 2026-02-18; v24.0 2025-10-08 | **CONFIRMED** — version table matches exactly, incl. v25.0 available-until 2028-07-29 | https://developers.facebook.com/docs/graph-api/changelog |
| 2 | Uploads go to `graph.facebook.com`, not `graph-video.facebook.com` | **CONFIRMED — and stronger than stated.** The page carries an explicit deprecation notice: *"The `graph-video.facebook.com` host for video uploads has been deprecated."* | https://developers.facebook.com/docs/video-api/getting-started/ |
| 3 | Chunked `upload_phase` protocol; Meta dictates chunk boundaries; loop ends on `start_offset == end_offset`; `finish` applies title/description; no offset-query call | **PARTIAL / UNCERTAIN.** Every *parameter and response field* confirmed verbatim on the `advideos` reference. The three *behavioural* claims are in **no currently reachable Meta doc** — the guide that described them was replaced by the Resumable Upload API guide. See the caveat box in §1.4. | https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/ |
| 4 | `video_id` unusable until `ready`; 7-value `video_status`; phase objects; `bytes_transfered` misspelling | **CONFIRMED**, plus two additions (`processing_progress`; the node reference contradicts the guide on the enum) — see §2.2 | https://developers.facebook.com/docs/video-api/guides/reels-publishing , https://developers.facebook.com/docs/graph-api/reference/video-status/ |
| 5 | `video_data` has no `link`; destination lives in `call_to_action.value.link` | **CONFIRMED.** Full 19-field `AdCreativeVideoData` list contains no `link`. CTA value `link` verbatim: *"The destination link when the CTA button is clicked. This is required to be same as the link url of the creative."* | https://developers.facebook.com/docs/marketing-api/reference/ad-creative-video-data/ , https://developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data-call-to-action-value/ |
| 6 | `instagram_actor_id` removed → `instagram_user_id`; `instagram_story_id` → `source_instagram_media_id`; `effective_instagram_story_id` → `effective_instagram_media_id`; from v22.0; Sept 9 2025 cutoff | **CONFIRMED.** `object_story_spec` reference contains `instagram_user_id` and no `instagram_actor_id`. Blog confirms all three mappings, v22.0, the accelerated 2025-09-09 date and the prior 2026-01-21 date. | https://developers.facebook.com/blog/post/2025/08/11/instagram-marketing-api-update/ , https://developers.facebook.com/docs/marketing-api/reference/ad-creative-object-story-spec/ |
| 7 | PBIA via `POST /{page_id}/page_backed_instagram_accounts`; no organic activity; black non-clickable name | **CONFIRMED.** Creation curl, *"it cannot perform any organic activities, such creating non-ad posts, commenting, or liking"*, and *"Ads from this account will show a non-clickable profile name in black, instead of the regular blue clickable profile name."* all verbatim. | https://developers.facebook.com/ads/blog/post/v2/2015/12/16/ig-accounts/ |
| 8 | Placement asset customization needs ≥2 rules; `optimization_type: PLACEMENT`; `is_default` is multi-language-only | **CONFIRMED, all three.** *"For Placement Asset Customization, every `asset_feed_spec` needs to have more than one customization rule attached to it."* / *"All ads using `asset_feed_spec` must contain at least two target customization rules."* / `is_default` — *"(Only Multi-Language ad) Indicate if the rule will act as a fallback when other rules don't match"* | https://developers.facebook.com/documentation/ads-commerce/marketing-api/dynamic-creative/placement-asset-customization , .../ad-creative/asset-feed-spec/asset-customization-rules , https://developers.facebook.com/docs/marketing-api/reference/ad-asset-feed-spec-asset-customization-rule/ |
| 9 | 30 assets; ≤10 videos/images; ≤5 bodies/titles/descriptions/CTAs/links; 1024/255/255 chars; `ad_formats` and `optimization_type` enums | **CONFIRMED, every number and both enums.** `optimization_type` = `ASSET_CUSTOMIZATION, LANGUAGE, PLACEMENT, REGULAR, FORMAT_AUTOMATION`. | https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/options/ , https://developers.facebook.com/docs/marketing-api/reference/ad-asset-feed-spec/ |
| 10 | Dynamic Creative on the ad set via `is_dynamic_creative`; one ad per ad set; ad set must be empty; delete the ad set not the ad; six objectives; no customization rules | **CONFIRMED, all of it**, including *"asset_feed_spec should not have customization rules"* on the parent asset-feed-spec page and *"`asset_feed_id` is only supported in Marketing API v3.1 and earlier."* | https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/dynamic-creative/ , https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/ |
| 11 | `standard_enhancements` deprecated v22.0 (2025-01-21), grace ended 2025-04-21; ~46 keys; video-only keys; 2026-06-28 API control | **CONFIRMED — with a material caveat.** Dates, decomposition lists and the 2026-06-28 OCC entries all verbatim. **But** the 46-field `AdCreativeFeaturesSpec` reference does **not** list `video_auto_crop`, `video_filtering`, `video_uncrop`, `image_uncrop`, `enhance_cta`, `image_brightness_and_contrast` or `image_text_translation`. Reference vs guide divergence documented in §8.2. | https://developers.facebook.com/blog/post/2025/01/17/marketing-api-v22-impacts-to-advantage-plus-creative-enhancements/ , https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/ , https://developers.facebook.com/docs/marketing-api/creative/advantage-creative/get-started/ , https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026 |
| 12 | Meta silently deletes ineligible `creative_features_spec` keys | **CONFIRMED verbatim.** *"Features specified as `OPT_IN` but ineligible for the given ad setup will be automatically removed from the `creative_features_spec` parameter."* Doc even gives the example: `image_templates` on a video ad. | https://developers.facebook.com/docs/marketing-api/creative/advantage-creative/get-started/ |
| 13 | v26.0 removes IG Explore Feed, silently strips `messenger_positions: story`, blocks poll creatives | **CONFIRMED**, all three quotes verbatim. Two corrections applied: the poll change affects **`GET`** `/generatepreviews` (not POST), and the Shops default has an opt-out value `WEBSITE_AND_SHOP_OPT_OUT` the draft omitted. | https://developers.facebook.com/docs/graph-api/changelog/version26.0/ |
| 14 | Ad video specs: MP4/MOV, H.264, 4 GB, per-placement ratios/durations, min width 250/500 px, 1% AR tolerance | **REFUTED on one number, otherwise CONFIRMED.** ~~video bitrate VBR **100 Mbps** max~~ → the source says **"VBR, 25Mbps maximum"**. Everything else verified per-placement: FB Feed 4:5 @1440×1800, 1 s–241 min, 50–150 / 27 chars; IG Reels 9:16 @1440×2560, 0 s–15 min; IG Stories 9:16 @1440×2560, 1 s–60 min, 1% AR tolerance, 250 px min width; FB Stories 9:16 @1440×2560, 1 s–3 min, 125 / 40 chars; `facebook_reels_overlay` **1:1 @1440×1440, 4–15 s** ✓. Also flagged: the moov-atom/4:2:0 block is an **organic IG publishing** spec (300 MB reels / 100 MB stories, 23–60 fps, ≤1920 px wide), not an ad spec. | https://www.facebook.com/business/ads-guide/video/facebook-feed , .../update/video/instagram-reels , .../instagram-story , .../facebook-story , .../facebook-facebook-reels-overlay , https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media |
| 15 | Safe zone 14% top / 35% bottom / 6% sides; looser 14%(250px)/20%(340px) on FB Stories; safe box x∈[65,1015], y∈[269,1248] on 1080×1920 | **CONFIRMED, both sets, and the arithmetic checks out.** IG Reels & IG Stories: *"at least 14% of the top, 35% of the bottom, and 6% on each side."* FB Stories: *"roughly 14% (250 pixels) of the top and 20% (340 pixels) of the bottom."* 0.06·1080=64.8→65; 0.14·1920=268.8→269; 1920−0.35·1920=1248. ✓ | as above |
| 16 | Preview returns an HTML iframe string; 76 `ad_format` values; `dynamic_asset_label`; generatepreviews public vs `/{ad_id}/previews` role-gated | **CONFIRMED, all four.** Enum counted: **exactly 76**, list matches character-for-character. `dynamic_asset_label` — *"Provide a label for rendering specific variation of an asset customization ad."* Visibility verbatim: *"Previews from an ad account are only visible to people who have a role on the ad account. Previews generated using `generatepreviews` edge are visible to anyone."* | https://developers.facebook.com/docs/marketing-api/reference/ad-account/generatepreviews/ , https://developers.facebook.com/docs/marketing-api/generatepreview/ , https://developers.facebook.com/docs/marketing-api/reference/ad-preview/ |
| 17 | Mandatory AI disclosure is SIEP-scoped only; `POLITICAL_WITH_DIGITALLY_CREATED_MEDIA` is the API surface; no general AI-disclosure field | **CONFIRMED.** Transparency Center quote verbatim, including *"we will reject the ad, and repeated failure to disclose may result in penalties against the advertiser."* `authorization_category` enum on the AdCreative reference = `POLITICAL`, `POLITICAL_WITH_DIGITALLY_CREATED_MEDIA`. No general AI-disclosure field exists on the node. **The draft's §13.3 scepticism about the SEO blogs is correct and should be kept.** | https://transparency.meta.com/policies/ad-standards/SIEP-advertising/SIEP/ , https://developers.facebook.com/docs/marketing-api/reference/ad-creative/ |
| 18 | Auto-detection of third-party AI media + "AI info" label; photorealistic humans get the label next to "Sponsored" | **CONFIRMED with a date caveat.** *"We will also begin automatically detecting ads created or edited using third-party AI tools through industry-standard signals. When detected, we'll apply an 'AI info' label included in About this ad."* Label placement for photorealistic humans confirmed. **Caveat:** the page is dated *"originally published February 3, 2025 … product updates reflected as of June 1, 2026"* — it does **not** say detection *begins* on 2026-06-01. Read 2026-06-01 as "in force as of", not "switched on that day". | https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/ |

### What was wrong

1. **Video bitrate: 100 Mbps → 25 Mbps.** The only outright factual error found. Corrected in §1.6.
2. **v26.0 poll change hits `GET` /generatepreviews, not `POST`.** Corrected in §0.
3. **Shops v26.0 default has a documented opt-out** (`WEBSITE_AND_SHOP_OPT_OUT`) that was omitted. Added in §0.
4. **AdCreative `status` enum was incomplete** — `IN_PROCESS` and `WITH_ISSUES` were missing, and those are the two an autonomous pipeline must branch on. Corrected in §4.5.
5. **`AdCreativeVideoData.video_id` description was paraphrased**, not verbatim. Corrected in §4.2.
6. **`tracking_specs` gotcha overstated.** Custom specs are not "silently replaced"; Meta overwrites the *defaults*, and you must re-add them yourself. Corrected in §12.2.
7. **The Resumable Upload API was under-weighted.** Meta's current video-upload guide documents *only* the resumable flow; the `upload_phase` protocol now exists only as edge parameters. Reframed in §1.1.

### What was missed (added above)

- **`processing_progress`** (int 0–100) on `VideoStatus` — a real progress signal for the polling loop, replacing blind backoff. §2.2.
- **The `VideoStatus` node reference contradicts the Reels guide** on the `video_status` enum (3 values vs 7). §2.2.
- **Seven Advantage+ feature keys are absent from the typed `AdCreativeFeaturesSpec` reference** while being documented in the guides — including all three video keys the brand-control recipe depends on. §8.2.
- **Instagram organic reel specs**: 23–60 FPS, ≤1920 horizontal px, 300 MB / 100 MB — and the fact that they are *organic*, not ad, limits. §1.6.

### Verified-clean spot checks (no change needed)

- CTA `type` enum — all 102 values match the reference character-for-character, including the easily-doubted `WOODHENGE_SUPPORT`, `SOTTO_SUBSCRIBE`, `SHOP_WITH_AI`, `TRY_ON_WITH_AI`.
- `AdAssetFeedSpecVideo` — `video_id`, `thumbnail_hash`, `thumbnail_url`, `adlabels`, `caption_ids`, **`url_tags`** all present with the quoted descriptions. The per-asset-UTM claim (Gotcha #16) holds.
- Placement-targeting enum — every value in §7.3's second table matches, including `facebook_reels`, `facebook_reels_overlay`, `profile_reels`, and `explore`/`explore_home` still being listed despite v26.0 removing Explore. **Gotcha #13 stands.**
- Flexible ad format — objectives, group constraints and the absence of any deprecation notice all confirmed. The §6.4 "official docs win" call is right.
- `conversion_specs` read-only since v2.4 — confirmed verbatim.
- Resumable Upload API MIME allowlist (`application/pdf, image/jpeg, image/jpg, image/png, video/mp4`) — confirmed verbatim.
- `asset_customization_rule` field list — all 13 fields match.

### Still unverified after this pass

- The three behavioural claims of the chunked upload loop (§1.4 box) — no current primary source.
- Whether `/act_{id}/advideos` accepts a Resumable Upload API file handle — still undocumented, but now **more likely than the draft assumed**; spike it.
- Everything in §15's open-questions table remains open; none of it was resolvable from primary sources on 2026-09-02.
- Meta's Business Help Center pages remain client-rendered and unscrapeable, so the per-objective CTA mapping (§10.1) is still empirical-only.

*Method note: this pass used WebFetch against `developers.facebook.com`, `transparency.meta.com`, `about.fb.com` and `facebook.com/business/ads-guide` only. No claim was upgraded to CONFIRMED on the strength of a blog or aggregator. The `withone.ai` mirror cited in §1 was not used as evidence for anything.*
