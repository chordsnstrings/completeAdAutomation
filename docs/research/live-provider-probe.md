# Live provider probe — captured 2026-09-02

Not from documentation or model memory: this is a **live capability listing** pulled
from the Higgsfield MCP model catalogue in-session on 2026-09-02, plus direct HTTP
probes. It is authoritative about *what exists right now* and supersedes any dossier
statement that contradicts it on model existence, aspect ratios, or duration ranges.

## Correction to the local `modelark` skill catalogue

The bundled `modelark` skill (`references/models.md`, captured 23 July 2026 against
`ark.ap-southeast.bytepluses.com`) states **"There is no Seedance 2.5."**

**That is now out of date.** Seedance 2.5 exists and is callable:

| id | modes | duration | resolution | audio |
|---|---|---|---|---|
| `seedance_2_5` | `t2v`, `omni_reference`, `video_edit`, `video_extension` | 4–30s | 480p/720p/1080p | native, `generate_audio` |

`video_edit` is billed by the *source* video's duration and ignores `duration` /
`aspect_ratio`. `video_extension` requires `extension_mode` (`backward`/`forward`)
and inherits the source aspect ratio.

Treat the BytePlus-direct catalogue as **per-key and time-varying**. Always
re-verify model availability at runtime rather than hardcoding a model list.

## Video models — aspect ratio is the binding constraint

This is the single most load-bearing finding for a Meta ad pipeline.

| Model | Provider | Aspect ratios | Duration | Native audio |
|---|---|---|---|---|
| `veo3` | Google | **16:9, 9:16 only** | (variant-driven) | yes |
| `veo3_1` | Google | **16:9, 9:16 only** | 4 / 6 / 8s | yes |
| `veo3_1_lite` | Google | 16:9, 9:16, auto | 4 / 6 / 8s | opt-in |
| `gemini_omni_flash_1_1` | Google | **16:9, 9:16 only** | 3–10s (edit: source, cap 30s) | yes |
| `seedance_2_5` | ByteDance | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 4–30s | yes |
| `seedance_2_0` | ByteDance | auto, 16:9, 9:16, 4:3, 3:4, 1:1, 21:9 | 4–15s | yes |
| `seedance1_5` | ByteDance | auto, 16:9, 9:16, 4:3, 3:4, 1:1, 21:9 | 4 / 8 / 12s | yes |
| `kling3_0` | Kling | 16:9, 9:16, 1:1 | 3–15s | yes |
| `minimax_h3` | MiniMax | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 4–15s | via refs |
| `wan3_0` / `wan3_0_prime` | Wan | auto, 16:9, 9:16, 1:1, 4:3, 3:4 | 2–30s | yes |
| `flux_3_video` | BFL | auto, 21:9, 2:1, 16:9, 4:3, 1:1, 3:4, 9:16 | 5–20s | yes |
| `grok_video_v15` | xAI | (unlisted) | 2–15s | via refs |
| `cinematic_studio_3_0` | Higgsfield | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 4–15s | opt-in |

**No video model in this catalogue generates 4:5 natively.** 4:5 is Meta's
recommended Feed video ratio. Therefore:

> The pipeline MUST own an ffmpeg reframing stage. Generate the master at 9:16
> (the tightest, most information-dense crop, and the native ratio for
> Reels/Stories which is where the volume is), then derive 1:1 and 4:5 by
> padding/blur-extending or saliency-aware cropping. 16:9 masters cannot be
> safely auto-cropped to 9:16 — too much subject loss — so 9:16-first is the
> correct master orientation for a Meta-first system.

Veo's hard restriction to 16:9/9:16 means Veo can produce the 9:16 master but
**never** a native square or 4:5 cut. Seedance can produce 1:1 natively, which
removes one reframe step but not the 4:5 one.

Duration also constrains format choice: Veo 3.1 caps at 8s per generation, so any
15–30s ad built on Veo requires multi-shot generation plus concatenation. Seedance
2.5 (up to 30s) and Wan 3.0 (up to 30s) can produce a full ad length in one call,
at the cost of less shot-level control.

## Image models — 4:5 IS natively available

| Model | Provider | 4:5 support | Notes |
|---|---|---|---|
| `nano_banana_pro`, `nano_banana_2`, `nano_banana` | Google | yes | 4:5 and 5:4 listed; strong text rendering on Pro |
| `seedream_v5_pro` | ByteDance | no (1:1,4:3,3:4,16:9,9:16,3:2,2:3,21:9) | inpaint + `remove_bg` params |
| `seedream_v4_5` | ByteDance | no | up to ~6K on `high` |
| `recraft_v4_1` | Recraft | yes | `vector`/`utility` model types, explicit hex palette + background colour — the best fit for **brand-locked** assets |
| `cinematic_studio_2_5` | Higgsfield | yes | up to 4K |
| `gpt_image_2`, `openai_hazel` | OpenAI | Hazel: no; GPT Image 2: no | best-in-class text rendering per tags |
| `marketing_studio_image` / `ms_image` | Higgsfield | yes | brand-kit-aware, product ids, IP check server-side |

Implication: **static** ad variants can be generated natively at 4:5, while
**video** cannot. That asymmetry argues for statics and video being separate
generation paths, not one pipeline with a ratio parameter.

`recraft_v4_1` accepting an explicit `colors` palette (up to 10 `#RRGGBB`) and
`background_color` is the cleanest primitive found for enforcing a brand kit
deterministically rather than by prompt-begging.

## Competitive intelligence found in the tool surface itself

The Higgsfield catalogue is itself evidence about the market — several entries are
productised versions of exactly the pipeline stages this project would build:

- **`marketing_studio_video` ("Marketing Studio")** — "one-click product ads,
  TikTok/Reels ready", 12–15s, with first-class concepts for `product_ids`,
  `avatar_ids`, `hook_id` ("the *what*" — attention mechanic, e.g. "object flies
  into frame"), `setting_id` ("the *where*" — location/vibe), and `ad_reference_id`
  (recreate an analysed existing ad's scenario). Presets: UGC, Tutorial, Unboxing,
  Product Review, UGC Virtual Try-On.
- **`ms_image` ("DTC Ads")** — brand-kit-aware image ads with a required `style_id`,
  up to 4 products, and a server-side **IP check before queueing**.
- **`ad_multiplier`** — "multiply my ad": N independently edited variants from one
  source video, powered by Seedance 2.5.
- **`clipify`** — YouTube → 9:16 clips with face-tracking crop and styled burned-in
  subtitles (font, case, highlight colour, position). This is the auto-reframing +
  caption-burn stage as a finished product.
- **`virality_predictor`**, **`video_analysis_*`** — pre-publish creative scoring.
- **`tiktok_publish` / `tiktok_prepare_publish` / `tiktok_accounts`** — a working
  publish integration, but for TikTok, **not** Meta.

The strategic read: **the creative-generation half of this problem is commoditised
and buyable.** The `hook` / `setting` / `ad_reference` decomposition is the same
"creative genome" idea the autonomy engine needs — and someone already ships it.

What is conspicuously absent across all of it: **no Meta publishing, no ad-account
connection, no spend control, no measurement loop, no learning.** Every one of these
tools terminates at "here is a file." That boundary is where the defensible work is.

## Direct HTTP probes

- `https://graph.facebook.com/` — reachable. Version path is permissive: `v99.0`
  did not error on the version itself, so a bogus-version probe is **not** a valid
  way to discover the current API version; token validation (`code:190`) fires
  first and masks version errors. Determine the current version from the official
  changelog, not by probing.
- `https://generativelanguage.googleapis.com/v1beta/models` — 403 unauthenticated
  (reachable, needs a key).
- `https://ark.ap-southeast.bytepluses.com/api/v3/models` — 401 unauthenticated
  (reachable, needs a key).

Network egress to all three provider families works from this environment.

## Credentials currently available in this environment

- No `ARK_API_KEY`, no Meta token, no Gemini key in the environment.
- `CLOUDSDK_AUTH_ACCESS_TOKEN` is set (Google Cloud) — a possible Vertex AI path,
  unverified for Veo entitlement.
- The `modelark` skill ships an **embedded** BytePlus key inside `scripts/ark.py`.
- Higgsfield MCP is connected and authenticated; `unlim.available` was `false` at
  probe time, so its generations bill credits.

**Nothing here is a substitute for the advertiser's own Meta credentials**, which
remain the one input that cannot be synthesised.
