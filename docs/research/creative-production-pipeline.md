# End-to-End Automated Video Ad Production Pipeline — Engineering Dossier

**Scope:** how a text brief becomes a publishable, Meta-spec `.mp4` (plus its aspect-ratio siblings) with no human in the loop. This is the *creative factory* — everything upstream of `POST /act_{id}/advideos`.

**Compiled:** 2026-09-02.

**Relationship to sibling dossiers in this directory** — read them for the parts deliberately *not* duplicated here:
- `meta-video-creative.md` — upload protocol, `object_story_spec`, `asset_feed_spec`, placement asset customization, per-placement specs and safe-zone percentages, Advantage+ creative opt-out.
- `meta-policy-compliance.md` — AI-disclosure rules, music licensing policy language, `dri_copyright` escalation, EU AI Act.
- `video-gen-google-veo.md` — Veo 3.1 / Gemini Omni request shapes, Google pricing, SynthID/C2PA, indemnification.
- `live-provider-probe.md` — live model catalogue captured in-session; **it supersedes any model-existence claim here.**

**Evidence grading used throughout:**
- **[MEASURED]** — I ran it in this environment on 2026-09-02 and am quoting the actual output. ffmpeg build: `7.0.2-static` (johnvansickle), config includes `--enable-libass --enable-libfreetype --enable-libfribidi --enable-libx264 --enable-libvmaf`, **no** `--enable-libharfbuzz`.
- **[SOURCE]** — quoted from official documentation or source code, URL given.
- **[UNVERIFIED]** — I could not confirm it. Treat as a research task, not a fact.

---

## 0. TL;DR for the architect

1. **The storyboard is the product, not the video.** Everything downstream is a deterministic function of a JSON shot list. Make that IR the versioned, content-addressed artifact and the whole pipeline becomes re-runnable, cacheable, and diffable. Ads are re-rendered constantly (new hook, new ratio, new price point); if the only artifact you keep is the mp4, every change is a full-price regeneration.
2. **Generate a keyframe image per shot, then animate it.** Text-to-video gives you no place to verify the product before you pay for motion. Image-to-video gives you a cheap ($0.01–0.24), fast, *inspectable* checkpoint where a VLM can reject a wrong logo before you spend $2.40 on 24 seconds of video. See §6.
3. **9:16 is the master orientation.** No video model in the live catalogue generates 4:5 natively, and 16:9→9:16 auto-crop destroys subjects. Render 9:16 1080×1920, derive 4:5 / 1:1 with ffmpeg. (`live-provider-probe.md`.)
4. **ffmpeg is the assembly engine and the QA harness.** `blackdetect`, `freezedetect`, `silencedetect`, `signalstats`, `ebur128`, `libvmaf` are all in a stock static build and give you machine-parseable gates. §14.
5. **Three ffmpeg defaults will silently produce Meta-noncompliant files**: non-square SAR from `pad`, 192 kHz audio from single-pass `loudnorm`, and `moov` at the end of the file without `+faststart`. All three verified below.
6. **Model-generated music is the single largest uninsured legal exposure in the pipeline.** Suno's own ToS assigns you rights but "makes no representation or warranty… that any copyright will vest in any Output," and *you* indemnify *them*. §10.
7. **Budget ≈ $1.05 / $2.95 / $8.50** for a 24 s ad at volume / standard / hero tier. The dominant line is video seconds; everything else is rounding. §17.

---

## 1. The pipeline as a DAG

Fourteen stages. The important design decision is that each edge carries a **typed, content-addressed artifact**, not a file path, so any stage can be resumed or cached independently.

```
 (1) brief ingest ────────► BriefSpec
 (2) audience/angle ──────► AngleSet[]          ── fan-out: N angles
 (3) script + hook ───────► ScriptSpec          ── per angle
 (4) storyboard ──────────► ShotList            ◄── THE IR. everything below is derived
 (5) keyframe images ─────► Keyframe[]          ── per shot, cacheable by content hash
 (6) product fidelity ────► Keyframe'[]         ── composite/inpaint real product, VLM verify
 (7) image→video ─────────► ShotClip[]          ── per shot
 (8) voiceover ───────────► VOTrack + WordTimings
 (9) music/SFX ───────────► MusicBed + SfxCue[]
(10) captions ───────────► CaptionScript (.ass)
(11) on-screen text ─────► OverlayLayer (.ass / PNG+alpha)
(12) assembly ───────────► MasterRender (9:16 1080×1920)
(13) ratio variants ─────► Deliverable[]        ── 9:16, 4:5, 1:1, (16:9)
(14) QA gates ───────────► QAReport → publish | quarantine
```

### 1.1 What actually breaks, per stage

| Stage | Dominant failure mode | Detection | Recovery |
|---|---|---|---|
| 1 brief | Missing the one fact that makes the ad legal (claims, price, disclaimers) | Schema validation with `required` on regulated fields | Halt; ask. This is the *only* human touchpoint worth keeping |
| 2 angle | Angle collapse — LLM returns 5 rephrasings of one idea | Embed the angles, reject pairs with cosine > 0.9 | Resample with the accepted set in the negative context |
| 3 script | Copy exceeds placement char budget; VO longer than the clip | Char count vs §9.2 of `meta-video-creative.md`; estimate VO duration at ~2.6 words/s before synthesis | Regenerate with a hard word budget in the prompt |
| 4 storyboard | Shot durations don't sum to target; shot count exceeds model max clip length | Arithmetic assertion on the IR | Re-plan; do not "fix in ffmpeg" |
| 5 keyframe | Text rendering garbage; wrong aspect; product absent | VLM check + OCR + `image_size` assertion | Retry with seed+1, then escalate model tier |
| 6 product | **Logo hallucinated, label text wrong, colour drift** | VLM diff vs reference + ΔE colour check on brand hex | Composite the real photo instead of generating it (§7) |
| 7 i2v | Product morphs mid-clip; text on packaging melts | Sample 4 frames, VLM-compare to keyframe | Shorten the clip; freeze-frame + Ken Burns fallback (§8.4) |
| 8 VO | Mispronounced brand name; wrong prosody at segment joins | Round-trip ASR and string-compare to script | Pronunciation dictionary / phoneme tags; `previous_text`/`next_text` |
| 9 music | Licence not actually cleared for paid ads | Licence record required per asset, or the build fails | §10 |
| 10 captions | Timings drift after any edit upstream | Re-align, never hand-edit timings | Forced alignment is cheap; re-run it |
| 11 overlays | Text lands under the Reels UI | Safe-zone bbox detector (§14.4) | Re-place, don't shrink |
| 12 assembly | Non-square SAR, VFR, 192 kHz audio, no faststart | ffprobe assertions (§12.7) | §12 recipes |
| 13 variants | Subject cropped out of frame in 1:1 | Saliency path + bbox check | §13 |
| 14 QA | Nothing — this stage exists so the other 13 can fail loudly | — | Quarantine, don't publish |

---

## 2. Stage 1–3: brief, angle, script

### 2.1 The BriefSpec is where legal risk enters the system

The human supplies free text. Freeze it into a schema immediately, because everything the pipeline later claims about the product traces back here, and a `dri_copyright` / advertising-standards complaint is answered from this record.

```json
{
  "brief_id": "sha256:…",
  "business": {"name": "...", "url": "...", "category": "..."},
  "product": {
    "name": "...", "price": {"amount": 4900, "currency": "USD"},
    "claims": ["waterproof to 50m"],
    "prohibited_claims": ["cures", "guaranteed results"],
    "regulated_category": null
  },
  "brand": {
    "palette_hex": ["#0A2540", "#00D4B1"],
    "logo_asset": "cas:sha256:…",
    "product_photos": ["cas:sha256:…", "cas:sha256:…"],
    "font_family": "Inter",
    "tone": ["confident", "warm"],
    "banned_visuals": ["competitor logos", "medical settings"]
  },
  "objective": "OUTCOME_SALES",
  "landing_url": "https://…",
  "market": {"country": "US", "language": "en-US"}
}
```

Two fields carry disproportionate weight:
- **`product_photos`** — without at least one real photo the pipeline is *inventing* the product, and every fidelity technique in §7 is unavailable. Make it required for any ad that shows the product.
- **`regulated_category`** — routes to a stricter copy generator and blocks the whole "let the model write claims" path.

### 2.2 Angle selection

An "angle" is the persuasion strategy, not the audience. The audience is a Meta targeting object (see `meta-optimization-controls.md`); the angle is a creative constraint that changes the script. Useful decomposition, which mirrors how Higgsfield's productised Marketing Studio models it (`hook_id` = "the what", `setting_id` = "the where", per `live-provider-probe.md`):

```
angle = { problem_frame, proof_type, hook_mechanic, setting, persona }
```

- `hook_mechanic ∈ {pattern_interrupt, question, bold_claim, before_after, demo_first, negative_hook, social_proof, price_anchor}`
- `proof_type ∈ {demo, testimonial, statistic, comparison, authority, ugc}`

Generating angles as a **cartesian sample over these enums** rather than as free-form LLM output is what prevents angle collapse. You get combinatorial diversity for free and each dimension becomes an independently learnable feature for the optimisation loop.

### 2.3 Script writing under hard constraints

The script generator must be told the *rendering* constraints, not just the creative ones:

| Constraint | Value | Why |
|---|---|---|
| VO words per shot | `round(shot_seconds × 2.4)` | 2.3–2.6 words/s is a natural ad read. Over-writing produces rushed TTS that no `speed` parameter fixes |
| First 3 seconds | must contain the hook *and* the product | sound-off, thumb-stop |
| Primary text | ≤ 40 chars cross-placement | FB Reels limit; see `meta-video-creative.md` §9.2 |
| Headline | ≤ 27 chars | FB Feed limit |
| On-screen text per shot | ≤ 6 words, ≤ 2 lines | safe-zone box is 951×980 px on a 1080×1920 canvas (§11.2) |
| Brand name pronunciation | supply IPA or a phonetic respelling | TTS gets invented brand names wrong ~always |

**Gotcha:** generate the VO script and the on-screen caption text as *the same string* unless you have a reason to diverge. Two different strings means two things to keep in sync, and burned-in captions that disagree with the voiceover read as a bug to viewers.

---

## 3. Stage 4: the ShotList IR

This is the load-bearing artifact. Everything below stage 4 is a pure function of it plus provider responses.

```json
{
  "shotlist_id": "sha256:…",
  "brief_id": "sha256:…",
  "angle_id": "hook=pattern_interrupt;proof=demo;setting=kitchen_morning",
  "target_seconds": 24,
  "master_ratio": "9:16",
  "master_resolution": [1080, 1920],
  "fps": 30,
  "global": {
    "style_prompt": "natural window light, shallow depth of field, 35mm, no text, no watermark, no logos other than the product's",
    "negative_prompt": "text, watermark, extra fingers, distorted label, competitor branding",
    "palette_hex": ["#0A2540", "#00D4B1"],
    "seed_base": 1734029
  },
  "shots": [
    {
      "id": "s1",
      "index": 0,
      "duration": 4.0,
      "purpose": "hook",
      "keyframe": {
        "prompt": "close-up of hands lifting the bottle off a marble counter, morning light",
        "product_role": "hero",
        "product_refs": ["cas:sha256:packshot_front"],
        "composite_strategy": "generate_scene_then_composite",
        "seed": 1734029
      },
      "motion": {"prompt": "slow push-in, subtle hand movement", "model_hint": "i2v"},
      "vo": {"text": "You have been washing it wrong.", "voice_id": "…"},
      "onscreen": [{"text": "WASHING IT WRONG?", "in": 0.3, "out": 2.4, "style": "hook"}],
      "sfx": [{"cue": "counter_set_down", "at": 1.2}]
    }
  ],
  "transitions": [{"after": "s1", "type": "fade", "duration": 0.5}],
  "music": {"prompt": "warm upbeat indie pop, no vocals, 96 BPM", "duck_db": -12},
  "cta": {"text": "Shop now", "in": 21.0}
}
```

**Design rules learned the hard way:**

1. **`duration` is authoritative and must be validated against the model's allowed set before any generation.** Veo 3.1 accepts 4/6/8 s only; Seedance 2.5 accepts 4–30 s; MiniMax H3 4–15 s (`live-provider-probe.md`, `minimax/references/api.md`). A shot list with a 5-second shot is unrenderable on Veo and the failure arrives 90 seconds and one billing event later.
2. **`seed` is per-shot and derived**: `seed_i = seed_base + index`. Never let the provider pick. Determinism is the entire basis of §16.
3. **Transitions consume real time.** If you use xfade, total duration is `Σ durations − Σ transition_durations` — **[MEASURED]**: three 4.0 s shots with two 0.5 s crossfades produced `Duration: 00:00:11.03`, not 12 s. Plan the shot list to the *post-transition* target, or the ad comes out short and the VO runs past the picture.
4. **Keep `composite_strategy` in the IR**, not in code. It is the switch between "trust the model with the product" and "paste the real product in" (§7), and it is the field you will A/B most.

---

## 4. Stage 5: per-shot keyframe generation

### 4.1 Model options for controllable stills

| Model | id / endpoint | Aspect ratios | Refs supported | Price | Notes |
|---|---|---|---|---|---|
| Nano Banana 2 | `gemini-3.1-flash-image` | 1:1, 3:2, 2:3, 3:4, 4:3, **4:5**, 5:4, 9:16, 16:9, 21:9 | **10 objects, 4 character images, 3 style refs** | ~$0.045 @0.5K, ~$0.067 @1K | best general workhorse |
| Nano Banana Pro | `gemini-3-pro-image` | same | **5 character images** | ~$0.134 @1K/2K, **$0.24 @4K** | best text rendering |
| NB2 Lite | `gemini-3.1-flash-lite-image` | same | 14 objects | ~$0.0336 | **1K only** |
| FLUX.2 [pro] | `POST https://api.bfl.ai/v1/flux-2-pro-preview` | width/height, up to 4MP | `input_image`, `input_image_2` … **up to 10** | $0.03 t2i / **$0.045 edit** | multi-reference editing |
| FLUX.2 [max] | `flux-2-max…` | up to 4MP | up to 10 | from $0.07 | grounding search |
| FLUX.2 [klein] 4B | — | up to 4MP | up to 10 | **from $0.014** | volume tier |
| Seedream 5.0 | `seedream-5-0-260128`, `POST /images/generations` | `1K`/`2K`/`4K` or `WxH` | `image` field | token-billed (~16k tok @2K) | **no 4:5**; 16,777,216 px ceiling |
| Recraft v4.1 | via Higgsfield catalogue | incl. 4:5 | — | — | explicit `colors` (≤10 hex) + `background_color` — the only *deterministic* brand-palette primitive found |

Sources: <https://ai.google.dev/gemini-api/docs/image-generation>, <https://docs.bfl.ml/quick_start/pricing.md>, <https://docs.bfl.ml/flux_2/flux2_image_editing.md>, `modelark/references/models.md`, `live-provider-probe.md`. Google per-image figures derived from token pricing in `video-gen-google-veo.md` §5.5.

### 4.2 Exact request shapes

**Gemini image** — reference images and aspect ratio are separate concerns; the ratio lives in `response_format`, not the prompt:
```json
{
  "model": "gemini-3.1-flash-image",
  "input": [{"role":"user","content":[
      {"type":"input_text","text":"<scene prompt>"},
      {"type":"input_image","image_url":"<product ref 1>"},
      {"type":"input_image","image_url":"<product ref 2>"}]}],
  "response_format": {"type":"image","mime_type":"image/png",
                      "aspect_ratio":"9:16","image_size":"2K"}
}
```
Multi-turn consistency uses **`previous_interaction_id`** — the model carries character/product identity forward across turns rather than re-deriving it from references each time. <https://ai.google.dev/gemini-api/docs/image-generation>

**FLUX.2 edit** — flat fields, async with a mandatory polling URL:
```json
POST https://api.bfl.ai/v1/flux-2-pro-preview
{"prompt":"<edit instruction>",
 "input_image":"https://…/packshot.jpg",
 "input_image_2":"https://…/scene.jpg"}
→ {"id":"…","polling_url":"https://…"}   # MUST poll polling_url, not a constructed URL
```

**Seedream (BytePlus ModelArk)** — synchronous **[SOURCE: `modelark/scripts/ark.py`]**:
```json
POST {ARK_BASE}/images/generations
{"model":"seedream-5-0-260128","prompt":"…","size":"2K",
 "response_format":"url","watermark":false,"seed":1734029,"image":"<ref url>"}
```

### 4.3 Keyframe stage gotchas

- **FLUX delivery URLs expire after 10 minutes.** *"Generated images expire after 10 minutes and become inaccessible."* Also: no CORS, and *"the `result.sample` URLs from delivery endpoints are not meant to be served directly to end users."* Download into your own content-addressed store inside the polling loop, not in a later stage. <https://docs.bfl.ml/api_integration/integration_guidelines.md>
- **MiniMax music/video URLs expire in ~24 h**; ByteDance's expire in 7 days. Any pipeline that stores provider URLs instead of bytes will look fine in test and fail a week later in production.
- **Seedream has a hard pixel ceiling of 16,777,216 px (4096²)** and returns `InvalidParameter` naming the limit. A 4K 9:16 request (2160×3840 = 8.3 MP) is fine; a 4K 21:9 is not.
- **Aspect ratio is not universal.** Seedream 5 Pro's ratio list has no 4:5 (`live-provider-probe.md`). If your static-ad path needs 4:5, that alone selects Nano Banana / Recraft over Seedream.
- **SynthID is unconditional on Gemini images**: *"All generated images include a SynthID watermark."* You cannot opt out, and per `meta-policy-compliance.md` you must not strip it.

---

## 5. Stage 6: why image-to-video beats text-to-video for brand work

This is the central architectural claim, so here is the actual reasoning rather than the slogan.

### 5.1 The verification argument (the real one)

Text-to-video is a single opaque transaction: prompt in, 8 seconds out, $0.80–$3.20 spent. If the logo is wrong you find out *after* paying, and your only lever is to re-roll the whole clip.

Image-to-video splits that into two transactions with a **cheap, inspectable checkpoint** between them:

| | cost | latency | inspectable |
|---|---|---|---|
| keyframe | $0.014–$0.24 | 5–30 s | yes — one PNG, VLM+OCR+ΔE in ~1 s |
| animate | $0.80–$3.20 | 60–240 s | only after the fact |

Rejecting at the keyframe costs **~3% of the price of rejecting at the clip**. With a realistic 30–40% first-pass reject rate on product fidelity, that ratio *is* the business case. Everything else people say about i2v (better composition control, etc.) is secondary to this.

### 5.2 The controllability argument

Image models expose primitives video models do not:
- exact multi-reference conditioning (`input_image_2..10`, 4–5 character refs)
- masked inpainting — replace *this region* and nothing else
- explicit hex palettes (Recraft `colors`)
- resolution up to 4 MP with legible packaging text

Video models expose motion, and almost nothing else. So: **decide everything spatial in image space, decide only temporal things in video space.**

### 5.3 The drift argument

Product identity degrades monotonically with generated frame count. A still is 1 frame; an 8 s clip at 30 fps is 240 chances for the label to melt. Pinning the first frame anchors the sequence — every i2v model in the catalogue conditions strongly on the start frame — but drift still accumulates, which is why **shorter shots are more brand-safe than longer ones**. A 24 s ad as 6 × 4 s shots holds the product better than 3 × 8 s, at the same total video cost.

### 5.4 When text-to-video is still right

- Abstract b-roll with no product in frame (lifestyle, texture, transitions).
- Native-audio shots where you want the model's synced dialogue/ambience (Veo 3.1, Seedance 2.5, MiniMax H3, FLUX 3 all generate audio) — but note you then inherit whatever music-like audio it invents, which reopens §10.
- Where the model supports it, **draft mode** makes t2v exploration cheap: FLUX 3 drafts render at `hd` for **$0.06/s vs $0.17/s** full render. <https://docs.bfl.ml/quick_start/pricing.md>

---

## 6. Stage 6 (cont.): keeping the product identical across shots

Ranked by fidelity, best first. Use the highest tier you can afford per shot; the hero shot deserves tier 1, background shots do not.

### 6.1 Tier 1 — composite the real photograph (highest fidelity, zero hallucination)

The product pixels are *the advertiser's actual pixels*. Nothing can hallucinate a label because nothing generates the label.

```
1. Background-remove the packshot → RGBA cutout      (alpha matte)
2. Generate the scene WITHOUT the product, leaving a plausible empty surface
3. Estimate placement: scale, position, perspective
4. Harmonise: match colour temperature + add contact shadow
5. Composite
```

ffmpeg does step 5 directly once you have RGBA:
```
ffmpeg -i scene.png -i product_rgba.png -filter_complex \
  "[1:v]scale=520:-1[p];[0:v][p]overlay=x=280:y=980:format=auto,setsar=1" out.png
```
The hard part is step 4. Un-harmonised composites read as fake instantly: the giveaway is always **missing contact shadow** and **mismatched colour temperature**, not resolution. A cheap, deterministic harmoniser that gets you most of the way:
- contact shadow: blur the alpha, offset it a few px along the scene's light direction, multiply at ~35% opacity
- colour match: compute mean/σ of the scene's L\*a\*b\* and shift the cutout's a\*/b\* toward it (Reinhard transfer), clamping so brand hexes don't drift outside ΔE ≈ 3

**Available cutout APIs:** Higgsfield `remove_background` (takes `media_id` + `media_type: "image"|"video"` — **video matting too**, which matters for compositing into generated clips); FLUX Erase (mask-driven, FLUX.2 Klein 9B); Bria's v2 image-editing endpoints include background remove / replace / blur (endpoint paths **[UNVERIFIED]** — the docs index lists 21 v2 endpoints but the reference page I could reach did not enumerate paths; <https://docs.bria.ai/>).

### 6.2 Tier 2 — reference-conditioned generation

Give the model the real photos and let it place them.

| Model | Mechanism | Capacity |
|---|---|---|
| FLUX.2 [pro]/[max] | `input_image`, `input_image_2`, … | **up to 10 images** |
| Nano Banana 2 | multimodal `input` blocks | 10 objects / 4 character / 3 style |
| Nano Banana Pro | same | 5 character images |
| MiniMax H3 | `reference_image` | **≤ 9** (plus ≤3 reference videos, ≤3 reference audio) |
| Seedance 2.5 | `omni_reference` mode | per catalogue |
| Seedream | `image` field | single ref (per `ark.py`) |

BFL documents this exact use case: *"FLUX.2 keeps product identity intact while changing context, background, or presentation. Upload a product photo or logo and describe the new setting — the model preserves branding, labels, shapes, and materials."* <https://docs.bfl.ml/guides/usecases_editing_product_consistency.md>

**Prompting pattern that materially helps**: FLUX.2's multi-reference docs index images as **"image 1", "image 2"** inside the prompt text, so write `"Place the bottle from image 1 onto the counter in image 2, preserving the label exactly"` rather than hoping positional order is inferred.

### 6.3 Tier 3 — inpaint the product region

Generate the full scene, mask the product, regenerate only inside the mask conditioned on the real packshot. Costs one extra edit call (~$0.045 on FLUX.2 pro) and fixes the common case where composition is right but the label is wrong. FLUX.1 Fill [pro] is the documented inpaint/outpaint surface; FLUX Erase is the mask-driven removal surface. <https://docs.bfl.ml/flux_1_fill.md>

### 6.4 Tier 4 — LoRA / fine-tune on the product

`flux-2-klein-9b-kv-finetuned` is billed **at the same rate as its base endpoint during public beta** (from $0.015). Worth it only for an advertiser with a long-running account and a stable SKU; the training turnaround and asset requirements make it wrong for a first ad. <https://docs.bfl.ml/quick_start/pricing.md>

### 6.5 The verification gate (do not skip)

Consistency is not a prompting problem, it is a **verification** problem. After every keyframe:

```python
checks = [
  vlm_yes_no("Is the product in this image identical in shape, colour and label text "
             "to the reference image?", image, reference),      # VLM, ~$0.002
  ocr_matches(image, expected_label_strings),                   # brand name spelled right
  delta_e(dominant_product_colour(image), brand_hex) < 5.0,     # colour drift
  no_extra_logos(vlm_list_brands(image), allowed={brand_name}),
]
```
Route failures by type: OCR failure → retry with a higher-tier model or composite; ΔE failure → re-run with explicit hex in the prompt (FLUX.2 documents hex-code prompting for exactly this: <https://docs.bfl.ml/guides/usecases_t2i_hex_color_prompting.md>); extra-logo failure → **hard reject, never retry**, because it is the `dri_counterfeit` / IP path described in `meta-policy-compliance.md`.

---

## 7. Using the advertiser's real photos: the four transformations

| Task | What it is | How | Watch out for |
|---|---|---|---|
| **Background replacement** | Keep product pixels, replace everything else | cutout → generate background → composite; or single-call background-replace endpoint | Edge halo on transparent/glossy products; glass and hair are where naive matting dies |
| **Product-on-model** | Garment/accessory worn by a generated person | FLUX Virtual Try-On (`flux_vto`): *"person image plus one or more garment references"* | Person likeness rights; sizing/fit distortion misrepresents the product (an ads-policy problem, not just aesthetics) |
| **Virtual staging** | Product placed in a room/scene it was never in | Generate scene → composite (tier 1) or reference-condition (tier 2) | Perspective mismatch. Ask the scene generator for a *specific* camera height/lens and place accordingly |
| **Real product in generated scene** | The general case | §6.1 | Lighting direction. Put the light direction in *both* the scene prompt and the shadow synthesis so they agree |

**The non-obvious one:** always generate the scene **without** the product and composite, rather than generating the scene *with* a product and then fixing it. Removing a generated product leaves an inpainting scar and the model has already committed to lighting the wrong shape. An empty-surface scene prompt (`"an empty marble counter, morning window light from camera left, space in the centre foreground"`) is easier to generate correctly *and* gives you a clean plate to reuse across product variants — which is how one scene amortises across an entire catalogue.

---

## 8. Stage 7: image-to-video

### 8.1 Model selection for i2v

Full ratio/duration matrix is in `live-provider-probe.md` §"Video models". For a Meta-first pipeline the binding facts are:

- **Veo 3.1 / Veo 3 / Gemini Omni Flash: 16:9 and 9:16 only.** They can make your 9:16 master and nothing else.
- **Veo 3.1 caps at 8 s per generation** → a 15–30 s ad is always multi-shot + concat.
- **Seedance 2.5 (4–30 s) and Wan 3.0 (2–30 s)** can render a whole ad in one call, trading shot-level control for fewer seams.
- **Turning audio off halves Veo 3.1's price** ($0.40/s → $0.20/s at 1080p) and **that option exists only on Vertex's price sheet.** Since this pipeline synthesises its own VO and music, audio-off is the correct default. (`video-gen-google-veo.md` §5.1.)
- **FLUX 3** i2v: $0.17/s hd, $0.29/s fhd, **draft $0.06/s**, up to 20 s. <https://docs.bfl.ml/quick_start/pricing.md>
- **MiniMax H3** i2v: `POST /v2/video_generation`, `role: "first_frame"` / `"last_frame"` — and when you pass an image, **`ratio` is forced to adaptive from the image**, so the keyframe's aspect ratio *is* the clip's aspect ratio. Body ≤ 64 MB. (`minimax/references/api.md`.)

### 8.2 First-frame and last-frame pinning

The highest-leverage feature in the whole stage. Pinning **both** ends turns a shot into an interpolation problem, which is far more controllable than open-ended generation:
- MiniMax H3: `role: "first_frame"` and `role: "last_frame"` in the `content` array.
- FLUX 3 i2v: *"pin a startframe, set a start and end frame, or interpolate through several keyframes."* <https://docs.bfl.ml/guides/prompting_video_image_to_video.md>

For a product ad this means you can generate keyframe A (product on counter) and keyframe B (product in hand) with the *same* reference conditioning, verify both stills, and only then pay for the motion between them.

### 8.3 Continuity across shot boundaries

Cheap trick that works: **use the last frame of shot N as a reference image for the keyframe of shot N+1.** Extract with
```
ffmpeg -sseof -0.1 -i shotN.mp4 -frames:v 1 -q:v 1 lastframe.png
```
This gives continuity of lighting, colour and set dressing without needing an explicit style-transfer step. It costs nothing and removes the most obvious "AI slideshow" tell.

### 8.4 The fallback that saves the render

When i2v fails QA twice, do **not** try a third time. Fall back to an animated still (Ken Burns). It is deterministic, free, and at 2–4 s per shot is nearly indistinguishable in a fast-cut ad.

**[MEASURED]** Naive `zoompan` on a 1080×1920 still visibly steps, because zoompan computes the crop at *source* resolution. Upscaling first fixes it and — counter-intuitively — was not slower in my run (3.26 s vs 4.00 s wall for a 4 s clip):
```
# jittery
-vf "zoompan=z='min(zoom+0.0015,1.25)':d=120:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30"
# smooth  ── upscale 4x with lanczos first, zoompan crops from the big canvas
-vf "scale=4320:7680:flags=lanczos,zoompan=z='min(zoom+0.0015,1.25)':d=120:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30"
```
Note `d=120` is in **frames**, and `zoompan` emits `d` frames per input frame — with `-loop 1` on a still plus `-t 4` you get exactly 4 s at 30 fps.

---

## 9. Stage 8: voiceover

### 9.1 Provider comparison

| Provider | Model / id | Price | Latency | Char limit / notes |
|---|---|---|---|---|
| **ElevenLabs** | `eleven_v3` | **$0.10 / 1K chars** | standard | 5,000 chars, 70+ langs, most expressive |
| | `eleven_v3_conversational` | **$0.05 / 1K chars** | **~280 ms** | 70+ langs |
| | `eleven_flash_v2_5` | **$0.05 / 1K chars** | **~75 ms** | 40,000 chars, 32 langs |
| | `eleven_flash_v2` | $0.05 / 1K | ~75 ms | 30,000 chars, English only |
| | `eleven_multilingual_v2` | $0.10 / 1K | standard | 10,000 chars, 29 langs, *"most stable on long-form"* |
| | `eleven_turbo_v2_5` / `_v2` | — | — | **deprecated**; use Flash |
| **OpenAI** | `tts-1` | **$15 / 1M chars** ( = $0.015/1K) | — | cheapest credible option |
| | `tts-1-hd` | **$30 / 1M chars** | — | |
| | `gpt-audio-mini` | $20 / 1M output tokens | — | steerable but token-priced |
| | `gpt-audio-1.5` / `gpt-audio` | $64 / 1M output tokens | — | |
| **Deepgram** | `aura-2` | **$0.030 / 1K chars** | — | |
| | `aura-1` | **$0.0150 / 1K chars** | — | |
| | Flux TTS | **free through 2026-09-12** | — | then standard rates |
| **Cartesia** | `sonic-3.6`, `sonic-3.5`, `sonic-3`, `sonic-latest` | **[UNVERIFIED]** | docs state no latency figure | `POST https://api.cartesia.ai/tts/bytes` |
| **MiniMax** | `/v1/t2a_v2` | **[UNVERIFIED]** | — | async long-form, voice clone/design |
| **Google Cloud** | Standard / WaveNet / Neural2 / Studio / Chirp3 HD / Gemini TTS | **[UNVERIFIED]** — pricing page is client-rendered and returned no figures | — | |
| **Azure AI Speech** | Neural / Neural HD / Custom Professional Voice / Personal Voice | **[UNVERIFIED]** — pricing table renders as `$-` placeholders | — | **Personal Voice is limited-access, pre-approved use cases only, application required** |

Sources: <https://elevenlabs.io/docs/models>, <https://elevenlabs.io/pricing/api>, <https://developers.openai.com/api/docs/pricing>, <https://deepgram.com/pricing>, <https://docs.cartesia.ai/api-reference/tts/bytes>, <https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/>.

**Cost reality check:** a 24-second ad read is ~60 words ≈ 350 characters. At ElevenLabs Flash that is **$0.0175**. At `tts-1` it is **$0.005**. Voiceover is *not* a cost driver — pick on quality and determinism, not price. The only place TTS cost matters is if you synthesise every script variant before selection; don't, synthesise after.

### 9.2 The two ElevenLabs request fields that matter for a pipeline

`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` <https://elevenlabs.io/docs/api-reference/text-to-speech/convert>

- **`seed`** (integer, 0–4294967295) — deterministic output. Without it your "identical" re-render produces a different read and every downstream caption timing shifts. This single field is what makes §16 possible for audio.
- **`previous_text` / `next_text`** — the fix for the classic per-shot-VO artifact where each segment is synthesised in isolation and the prosody resets at every cut. Pass the neighbouring script lines and the reads join naturally.
- `voice_settings`: stability, similarity, speed, style, speaker boost.
- `apply_text_normalization`: `"auto" | "on" | "off"` — turn it **on** for prices and units ("$49" → "forty-nine dollars"), and **off** if you have pre-normalised the text yourself, or you get double-expansion.
- `output_format` default `mp3_44100_128`. **Ask for PCM/WAV at 48 kHz** for the intermediate — you are going to mix and loudness-normalise it, and an mp3 intermediate costs you a generation of lossy artefacts for nothing. (Note: *"MP3 with 192kbps bitrate requires you to be subscribed to Creator tier or above."*)

### 9.3 Voice cloning: what is actually allowed

- ElevenLabs **Instant Voice Cloning**: you must *"confirm that you have the right and consent to clone the voice"* before saving. <https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning>
- ElevenLabs **Professional Voice Cloning**: *"we only allow you to clone your own voice"* and, explicitly, *"You can only create a Professional Voice Clone of your own voice. Even with their consent, you cannot clone someone else's voice."* Requires an in-product **voice verification** step (re-record using similar equipment and delivery to the samples; on failure, *"wait 24 hours to try verification again"*), and **30 minutes minimum audio, 2–3 hours recommended**. <https://elevenlabs.io/docs/product-guides/voices/voice-cloning/professional-voice-cloning>
- Azure **Personal Voice** is a *"limited access feature restricted to certain pre-approved use cases only"*, gated behind an application form.
- ElevenLabs states *"All audio generated by our models can be instantly traced back to the user responsible for the generation."*

**Engineering consequence for an autonomous platform:** you cannot offer "clone the founder's voice" as a self-serve, no-human-in-the-loop feature on ElevenLabs PVC — the verification is a first-person, in-product act by the voice owner and it 24-hour-rate-limits on failure. **Design for the stock voice library as the default path**, and treat cloning as an out-of-band onboarding step performed by the advertiser themselves. Store the resulting `voice_id` in the brand record.

**[UNVERIFIED / legal]** US state right-of-publicity statutes covering synthetic voice (Tennessee's ELVIS Act and comparable laws elsewhere) and any 2026 federal action were not researched here. Do not ship a voice-cloning feature without counsel; the platform, not the advertiser, is the plausible defendant.

### 9.4 Quality for ad reads — what actually separates providers

Ad copy is short, punchy, and full of the two things TTS handles worst: **brand names** and **prices/units**. Practical mitigations, in order of impact:
1. **Round-trip verify.** Synthesise → transcribe → compare to the script. A brand name mangled by TTS is caught here for ~$0.0002. This gate has the best cost/benefit ratio in the entire pipeline.
2. **Pronunciation control.** ElevenLabs supports pronunciation dictionaries (`pronunciation_dict_id` also exists on Cartesia). Build one per brand at onboarding, keyed off the round-trip failures.
3. **Split by sentence, not by shot.** Synthesise each *sentence* with `previous_text`/`next_text`, then place sentences on the timeline. Splitting mid-sentence at a shot boundary is what produces the robotic-join artifact.
4. **Do not use `speed` to fit a timing budget.** Rewrite the line shorter. Time-stretched TTS is audible at >1.1×.

---

## 10. Stage 9: music and SFX — the largest uninsured risk in the pipeline

### 10.1 What Meta requires

Quoted in `meta-policy-compliance.md` §10.1, from <https://transparency.meta.com/policies/ad-standards/intellectual-property-infringement/third-party-infringement/>:

> *"If your ad contains music you are required to secure the necessary licenses (e.g. for the sound recording and/or the musical composition) in order to avoid infringing or violating the intellectual property rights of music rights holders."*

Two traps that follow:
- **Instagram's in-app music library is for organic content, not ads.**
- **Meta Sound Collection** is licensed *"for commercial or non-commercial purposes in content they create, upload, and distribute on Meta Company Products"* but *"may not perform, distribute, make available or otherwise use the audio content separately from the Meta Company Products."* → **Sound Collection audio cannot be reused on TikTok, YouTube or the advertiser's own site.** For a multi-channel platform it is a licence-breach generator.
- New in 2026: `POST /act_{id}/advideos` accepts `source_instagram_media_id` + `selected_audio_spec` to **swap copyrighted music for Sound Collection audio**, polling `replace_audio_status` until `SUCCESSFUL`. But that path only works from an existing IG media id — useless for a freshly rendered file. Generate clean audio in the first place. (`meta-video-creative.md` §1.2.)

### 10.2 Generative music options and their actual licence terms

| Option | API | Price | Licence position |
|---|---|---|---|
| **ElevenLabs Music** | `music_v2`; 3 s – 5 min | **$0.15 / min** | *"Eleven Music is cleared for nearly all commercial uses, from film and television to podcasts and social media videos, and from advertisements to gaming."* Free plan requires attribution (*"Created in collaboration with ElevenLabs"*). Upgrading applies new terms retroactively to existing outputs; downgrading preserves prior rights but restricts new creations. Explicit non-exclusivity: *"Output you generate using Music may not be unique and may be similar or identical to Output returned to other users."* |
| **MiniMax Music** | `POST /v1/music_generation`, `model: "music-3.0"` | **[UNVERIFIED]** | Synchronous; returns HTTP 200 even on failure — **check `base_resp.status_code`**. `lyrics` 10–1000 chars with `[Intro] [Verse] [Chorus]…` tags; `is_instrumental: true`; `output_format: "url"` expires ~24 h. A `music-cover` model exists — *"rights to the source recording are the caller's problem; the endpoint existing is not a licence."* |
| **Suno** | — | — | **Paid tiers:** *"Suno hereby assigns to you all of its right, title and interest in and to any Output owned by Suno…"* **but** *"Suno makes no representation or warranty to you that any copyright will vest in any Output."* **Free/Basic: non-commercial only, with attribution.** Users **indemnify Suno**, not the reverse. <https://suno.com/terms> |
| **Google Lyria 2 / Lyria 3** (Vertex) | `lyria-002`, `lyria-3` | **[UNVERIFIED]** | Model pages did not render; but Vertex GA models carry Google's generative-AI **indemnification** for paid, GA models (`video-gen-google-veo.md` §7.3), which is the strongest legal position available if Lyria qualifies. **Verify Lyria's indemnification status before relying on it.** |
| **Stock libraries** (Epidemic Sound, Artlist, Soundstripe, Musicbed) | Epidemic partner API: **[UNVERIFIED]** — `epidemicsound.com/partner/api/` 404s and `partners.epidemicsound.com` does not resolve | subscription | A real, human-cleared licence with a named counterparty. The boring answer, and probably the right one for regulated verticals |

### 10.3 The engineering position

**Rank by who bears the risk, not by audio quality:**

1. **Indemnified generative** (Vertex GA models, *if* Lyria is covered) — provider bears it.
2. **Explicitly ad-cleared generative** (ElevenLabs Music, on a paid plan) — provider asserts clearance; you keep the receipt.
3. **Licensed stock library** — human-cleared, contractual, auditable.
4. **Assigned-but-disclaimed generative** (Suno paid) — you own whatever there is to own, which the provider declines to warrant exists, *and you indemnify them*. For a platform running thousands of advertisers' ads this is a structurally bad trade.
5. **Model-native audio inside a video model** (Veo/Seedance/H3 "generate audio") — **the worst position**, because the audio is not a separately licensed artifact at all and you cannot produce a licence record for it. If you use native-audio video models, **strip the audio and replace it** (`-an` on the ffmpeg import).

**Non-negotiable implementation requirement:** every shipped ad must carry a music provenance record, and the build must *fail* without one:
```json
{"asset":"cas:sha256:…","source":"elevenlabs_music_v2","plan_tier":"scale",
 "prompt":"…","seed":null,"generated_at":"2026-09-02T…","licence_ref":"…",
 "cleared_for":["paid_social_ads"],"attribution_required":false}
```
This is the same provenance ledger `meta-policy-compliance.md` §requires for a `dri_copyright` defence, and it is the only way to find every other ad sharing a tainted asset lineage.

### 10.4 Ducking and the mix

Music must sit under the VO or the ad is unwatchable sound-on. Deterministic sidechain duck in one pass:
```
ffmpeg -i music.wav -i vo.wav -filter_complex \
 "[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[m]; \
  [1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[v1][vsc]; \
  [m][vsc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=250:makeup=1[mduck]; \
  [mduck][v1]amix=inputs=2:duration=longest:normalize=0[a]" -map "[a]" mix.wav
```
`asplit` is required — the sidechain key and the audible VO must be separate branches or the VO is consumed by the compressor. Set the music bed ~12 dB under the VO before compression (`volume=-12dB`) so the compressor is doing shaping, not rescue.

---

## 11. Stage 10: captions and subtitles

### 11.1 Why burned-in, not SRT

Meta's video ads have no reliable viewer-toggled caption track across all placements, and the dominant consumption mode is sound-off. Burned-in captions are the only ones guaranteed to render. Practically:
- **Burn in** for the delivered creative.
- **Also emit an `.srt` sidecar** — you need it for accessibility review, for the ad copy generator (the caption text *is* the on-screen text budget), and for the learning loop (mapping performance to spoken hooks).

### 11.2 Forced alignment: getting word timings you can trust

You have the script (you wrote it) and the audio (you synthesised it). This is **forced alignment**, not transcription, and it is a much easier problem — but most APIs only expose transcription.

| Route | How | Notes |
|---|---|---|
| **WhisperX** | Whisper + **wav2vec2 phoneme model** for forced alignment | *"70x realtime transcription using whisper large-v2"*; VAD preprocessing *"reduces hallucination & batching with no WER degradation"*; produces phone-level segmentation. **Limitations (stated):** words with non-dictionary characters like `"2014."` cannot be aligned; overlapping speech is suboptimal; needs a language-specific wav2vec2 model. <https://github.com/m-bain/whisperX> |
| **OpenAI API** | `timestamp_granularities: ["word"]` | **GOTCHA: word timestamps are `whisper-1` only, and require `response_format: "verbose_json"`.** The newer `gpt-transcribe` / `gpt-4o-transcribe` models do **not** support them. 25 MB file limit; mp3/mp4/mpeg/mpga/m4a/wav/webm. $0.006/min. <https://developers.openai.com/api/docs/guides/speech-to-text> |
| **Deepgram** | Nova-3, word timings native | $0.0048/min streaming PAYG (pre-recorded is cheaper) |
| **AssemblyAI** | Universal-3.5 Pro $0.21/hr; Universal-2 $0.15/hr | word-timestamp inclusion **[UNVERIFIED]** from the pricing page |
| **ElevenLabs Scribe** | Scribe v2 **$0.22/hr**; Scribe v2 Realtime $0.39/hr | same vendor as the TTS — convenient for round-trip verification |

**Recommendation:** WhisperX self-hosted for alignment (it is the only option that is *actually* forced alignment against a known transcript, and at 24 s of audio the compute is trivial), with Deepgram or `whisper-1` as a managed fallback. Cost at 24 s: **$0.002 or less** either way. This stage is free; do not optimise it.

**The critical correctness rule:** timings are derived, never authored. Any change to the VO — a re-synthesis, a different seed, a rewritten line — invalidates every caption timing. Re-align; never patch offsets.

### 11.3 Burn-in mechanics: `ass` vs `subtitles`

Both are libass. **[MEASURED]** both work in a stock static build; `drawtext` does **not** (see §11.5).

- **`subtitles=file.srt:force_style='…'`** — convenient, converts SRT→ASS internally.
- **`ass=file.ass`** — full control: per-word karaoke highlighting, animated `\move`, per-event margins, exact PlayRes.

**Use `ass`.** Word-level highlight ("TikTok-style" captions) is the format that performs, and it requires ASS override tags anyway.

**[MEASURED] A working, safe-zone-correct ASS header for 1080×1920:**
```
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,6,0,2,65,65,672,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Cap,,0,0,0,,THIS IS THE HOOK
Dialogue: 0,0:00:02.00,0:00:05.00,Cap,,0,0,0,,{\c&H00FFFF&}HIGHLIGHTED{\c&HFFFFFF&} WORD
```
Notes on the numbers, all of which are load-bearing:
- `PlayResX/Y` **must** equal the video dimensions, or every size and margin is scaled by libass.
- `MarginV: 672` = 35% of 1920 → puts the caption bottom exactly at Meta's strict bottom safe-zone boundary. **[MEASURED]** rendered text bbox `(223,1187)–(859,1234)`, and the safe-zone limit is y ≤ 1248. Inside, with 14 px to spare.
- `MarginL/R: 65` ≈ 6% of 1080 (safe box x ∈ [64, 1015]).
- `BorderStyle: 3` + `Outline: 6` + `BackColour &H96000000` gives an opaque-ish box; `BorderStyle: 1` with a heavy outline gives the outlined-text look. **Never ship captions without an outline or box** — white text on a bright generated frame is unreadable and you have no control over the frame.
- **Colours are `&HAABBGGRR`** — BGR order with an *inverted* alpha (`00` = opaque, `FF` = transparent). Getting brand colours wrong here is a 30-minute debugging session; write a converter.
- `-1` in the Bold column means **true**. ASS booleans are `-1`/`0`, not `1`/`0`.

### 11.4 The `force_style` font-size trap

**[MEASURED + SOURCE]** With the `subtitles` filter on an SRT, `Fontsize=24` rendered a **263 px-tall** two-line caption on a 1080×1920 video — not 24 px.

Cause, from FFmpeg source `libavcodec/ass.h` (identical in n6.1, n7.0 and master):
```c
#define ASS_DEFAULT_PLAYRESX 384
#define ASS_DEFAULT_PLAYRESY 288
#define ASS_DEFAULT_FONT     "Arial"
#define ASS_DEFAULT_FONT_SIZE 16
#define ASS_DEFAULT_ALIGNMENT 2
```
FFmpeg's SRT→ASS converter writes `PlayResY: 288`, and libass scales everything by `video_height / PlayResY` = **1920/288 = 6.667×**. So `Fontsize=24` → ~160 px, and `MarginV=112` → ~747 px.

**Consequences:** (a) the same `force_style` string produces wildly different results on 1080p vs 4K; (b) `original_size=1080x1920` did **not** change the outcome in my test. **Fix: author real `.ass` files with explicit `PlayResX/Y`.** Never tune `force_style` numbers by eye.

### 11.5 `drawtext` may not exist in your ffmpeg

**[MEASURED]** `ffmpeg -h filter=drawtext` → `Unknown filter 'drawtext'` on a build configured with `--enable-libfreetype --enable-libfribidi --enable-fontconfig`.

**[SOURCE]** FFmpeg's `configure`:
```
n6.0 :  drawtext_filter_deps="libfreetype"
n6.1 :  drawtext_filter_deps="libfreetype libharfbuzz"
n7.0 :  drawtext_filter_deps="libfreetype libharfbuzz"
master: drawtext_filter_deps="libfreetype libharfbuzz"
```
**libharfbuzz became a hard dependency for `drawtext` between n6.0 and n6.1.** Any build (including widely used static builds and many distro/container images) that predates or omits harfbuzz silently has no `drawtext` — and the failure appears at *render* time, in production, as `Unknown filter`.

**Architectural conclusion: do not build the text system on `drawtext`.** Use `ass`/`subtitles` (libass, dependency-stable) for all text — captions, hooks, price flashes, CTA. It is also strictly more capable: real typography, per-word animation, precise margins. Reserve `drawtext` for nothing.

If you need effects libass cannot do, render text to **RGBA PNG** with PIL/Skia and `overlay` it — deterministic, fully controllable, and it removes the font-availability question from the render host entirely. (Font availability is its own trap: this container had **59** fonts and no Inter, Helvetica or Arial. Ship your brand fonts into the render image and reference them by absolute path.)

---

## 12. Stage 12: ffmpeg as the assembly engine

All commands below were executed in this environment. ffmpeg **7.0.2-static**.

### 12.1 Concatenation: never stream-copy generated clips

The `concat` demuxer with `-c copy` requires identical codec parameters, timebase and SAR across inputs. Clips from different models — or the *same* model on different days — will differ. It fails loudly if you are lucky and produces broken timestamps if you are not.

**[MEASURED]** three 4.0 s clips:
| method | result |
|---|---|
| `-f concat -c copy` | `00:00:12.02` |
| `concat` **filter**, re-encode | `00:00:12.03` |
| `xfade` chain, 0.5 s transitions | `00:00:11.03` |

**Always re-encode.** The pipeline re-encodes for Meta anyway (§12.6), so the "saving" from stream-copy is imaginary.

```
ffmpeg -i s1.mp4 -i s2.mp4 -i s3.mp4 -filter_complex \
  "[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac out.mp4
```
**Precondition for the `concat` filter:** all video inputs must share width, height, SAR and pixel format, and all audio inputs must share sample rate and channel layout. Normalise *before* concatenating:
```
[i:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p[vi];
[i:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ai];
```

### 12.2 Crossfades: `xfade` + `acrossfade`

`xfade` takes **two** inputs, so N clips need N−1 chained instances, and **`offset` is measured on the accumulating output timeline**, not on the source clip. This is where people lose an afternoon.

**[MEASURED]** working 3-clip chain (4 s each, 0.5 s transitions):
```
ffmpeg -i s1.mp4 -i s2.mp4 -i s3.mp4 -filter_complex "\
[0:v][1:v]xfade=transition=fade:duration=0.5:offset=3.5[vx1];\
[vx1][2:v]xfade=transition=smoothleft:duration=0.5:offset=7.0[v];\
[0:a][1:a]acrossfade=d=0.5:c1=tri:c2=tri[ax1];\
[ax1][2:a]acrossfade=d=0.5:c1=tri:c2=tri[a]" \
 -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac out.mp4
```
**Offset formula:**
```
offset_k = Σ_{i<=k} duration_i − Σ_{i<=k} transition_i        (k = 0-indexed transition)
total    = Σ duration_i − Σ transition_i
```
Check: `4+4 − 0.5 = 7.5`? No — `offset_0 = 4 − 0.5 = 3.5`, `offset_1 = 8 − 1.0 = 7.0`, `total = 12 − 1.0 = 11.0`. **[MEASURED]** output `00:00:11.03`. ✔

**[MEASURED] Full `transition` enum in 7.0.2** (values −1…57): `custom, fade, wipeleft, wiperight, wipeup, wipedown, slideleft, slideright, slideup, slidedown, circlecrop, rectcrop, distance, fadeblack, fadewhite, radial, smoothleft, smoothright, smoothup, smoothdown, circleopen, circleclose, vertopen, vertclose, horzopen, horzclose, dissolve, pixelize, diagtl, diagtr, diagbl, diagbr, hlslice, hrslice, vuslice, vdslice, hblur, fadegrays, wipetl, wipetr, wipebl, wipebr, squeezeh, squeezev, zoomin, fadefast, fadeslow, hlwind, hrwind, vuwind, vdwind, coverleft, coverright, coverup, coverdown, revealleft, revealright, revealup, revealdown`.
Options: `transition`, `duration` (default 1), `offset` (default 0), `expr` (for `custom`).

**Ad-craft note:** for short-form performance ads, **hard cuts outperform transitions**. Use `xfade` for `fade`-to-CTA and little else; a 0.5 s crossfade in a 24 s ad is 2% of your runtime spent on nothing.

`acrossfade` curve options (`c1`/`c2`): `nofade, tri, qsin, esin, hsin, log, ipar, qua, squ, cbr, par, exp, iqsin, ihsin, dese, desi, losi, sinc, isinc, quat, quatr, qsin2, hsin2`. Use `tri` unless you have a reason.

### 12.3 Aspect conversion: scale+pad vs crop — and the SAR bug

**[MEASURED] This is the highest-value finding in the section.** Converting a 1080×1920 master to 4:5 (1080×1350):

| Recipe | Output |
|---|---|
| `scale=1080:-2,crop=1080:1350` | `1080x1350 [SAR 1:1 DAR 4:5]` ✔ |
| `scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2` | `1080x1350` **`[SAR 2025:2024 DAR 405:506]`** ✘ |
| …`,setsar=1` appended | `1080x1350 [SAR 1:1 DAR 4:5]` ✔ |
| `scale=…:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,pad=…` | `1080x1350 [SAR 1:1 DAR 4:5]` ✔ |

**Mechanism:** `force_original_aspect_ratio=decrease` computed a fractional width (1080×1350/1920 = 759.375), rounded to an even 760, and **compensated by setting SAR to 2025:2024 to preserve the exact DAR**. `pad` inherits that SAR. The output therefore has **non-square pixels** — and Meta's stated video requirement is *"H.264 compression, **square pixels**, fixed frame rate, progressive scan and stereo AAC audio compression at 128kbps+"* (`meta-video-creative.md` §1.6). This is a spec violation that no visual inspection will catch.

**[MEASURED] Related failure:** the same `scale` used *without* a following `pad` produced an odd width and libx264 refused outright:
```
[libx264] width not divisible by 2 (759x1350)
[vost#0:0/libx264] Error while opening encoder
```

**Rules:**
1. **Always terminate a geometry filter chain with `setsar=1`.** No exceptions.
2. Prefer `force_divisible_by=2` on every `scale` that uses `force_original_aspect_ratio`.
3. Assert `sample_aspect_ratio == "1:1"` in the QA gate (§14.1).

**Which to use — crop or pad?** For Meta video, **crop**. Padding produces letterboxed video, which (a) wastes the scarcest resource in a Reels ad — screen area — and (b) reads as repurposed content. The blur-extend variant is the acceptable middle ground when a crop would destroy the composition:
```
ffmpeg -i master.mp4 -filter_complex "\
[0:v]split=2[bg][fg];\
[bg]scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350,gblur=sigma=40[bgb];\
[fg]scale=1080:1350:force_original_aspect_ratio=decrease[fgs];\
[bgb][fgs]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1[v]" \
 -map "[v]" -map 0:a -c:a copy out_4x5.mp4
```
**[MEASURED]** yields `1080x1350 [SAR 1:1 DAR 4:5]` ✔ (the `setsar=1` inside the overlay chain is doing the work).

### 12.4 Loudness normalisation — and the 192 kHz trap

Target **−14 LUFS integrated, −1.0 dBTP** for social video. (Meta does not publish a loudness target; −14 LUFS is the de-facto streaming convention and keeps you from being the ad that blows out someone's earbuds. **[UNVERIFIED]** as a Meta requirement.)

**[MEASURED] `loudnorm` options in 7.0.2:**
```
I / i            integrated target      −70 … −5     default −24
LRA / lra        loudness range         1 … 50       default 7
TP / tp          max true peak          −9 … 0       default −2
measured_I, measured_LRA, measured_TP, measured_thresh, offset
linear           bool                                default true
dual_mono        bool                                default false
print_format     none | json | summary               default none
```

**Pass 1 — measure:**
```
ffmpeg -i in.mp4 -af "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json" -f null -
```
**[MEASURED]** emits exactly:
```json
{ "input_i":"-21.91","input_tp":"-20.01","input_lra":"0.50","input_thresh":"-31.91",
  "output_i":"-13.91","output_tp":"-11.98","output_lra":"0.40","output_thresh":"-23.91",
  "normalization_type":"dynamic","target_offset":"-0.09" }
```
Parse that JSON (it is the last JSON object on stderr) and feed it back.

**Pass 2 — apply:**
```
ffmpeg -i in.mp4 -af "loudnorm=I=-14:TP=-1.0:LRA=11:\
measured_I=-21.91:measured_TP=-20.01:measured_LRA=0.50:measured_thresh=-31.91:\
offset=-0.09:linear=true,aresample=48000" \
  -c:v copy -c:a aac -b:a 128k -ar 48000 -ac 2 out.mp4
```
**[MEASURED]** result verified with `ebur128`: `I: -14.0 LUFS`. ✔

**THE TRAP — [MEASURED]:** single-pass (dynamic-mode) `loudnorm` **outputs at 192000 Hz**.
```
# dynamic mode, output to flac, no -ar specified
Stream #0:0: Audio: flac, 192000 Hz, stereo, s32 (24 bit)
# ashowinfo confirms the filter's own output rate
n:0 pts:0 ... rate:192000 nb_samples:19200
# two-pass with linear=true
Stream #0:0: Audio: flac, 48000 Hz, stereo, s32 (24 bit)
```
Meta's spec is **AAC, 48 kHz max**. If your VO/mix intermediate is WAV or FLAC and you used single-pass loudnorm, you have silently created 192 kHz audio and 4× the file size. AAC encoding usually rescues it (ffmpeg auto-inserts a resampler when the encoder can't take 192 k), but *intermediates* are where this bites, and it also changes sample counts, which perturbs anything doing sample-accurate cue placement.

**Rules:** always do **two passes** with `linear=true`, and always append `aresample=48000` regardless. Two-pass is also the only way to get *predictable* gain — dynamic mode applies time-varying gain and will pump under a music bed.

### 12.5 Reframing 16:9 → 9:16 with subject awareness

Naive centre-crop from 16:9 to 9:16 keeps **31.6%** of the width (`1080/1920` at equal height) and throws away 68%. For an ad where the product is off-centre, that is a total loss. Options:

**(a) `cropdetect` — does NOT do this.** **[MEASURED]** run against a full-frame 1080×1920 clip it returned `crop=1080:1920:0:0`. `cropdetect` finds **letterboxing/pillarboxing** (uniform borders), not subjects. Use it to strip black bars from a provider's output; never for reframing.

**(b) Managed APIs:**
- **Higgsfield `reframe`** — *"Expand or reframe an existing video to a new aspect ratio while preserving the source content."* `aspect_ratio ∈ {16:9, 9:16, 4:3, 3:4, 1:1, 21:9}`; **max 60 s**; for sources **over 15 s** you must pass `duration_seconds` **and** `resolution ∈ {480p,720p,1080p}` and supply *only* the source video (no reference images). `get_cost: true` preflights credits. Note it *expands* (outpaints the new edges) rather than cropping — different tradeoff: you keep the whole subject but the model invents the edges. **No 4:5.**
- **Cloudinary** — `c_fill,g_auto:faces,ar_9:16` for content-aware video cropping; `ar` accepts `a:b` or decimals; crop modes `c_fill`, `c_pad`, `c_crop`. Docs caution that with ratio-changing crop modes *"it's generally recommended to specify both width and height or width/height along with an aspect ratio"* for predictable results. <https://cloudinary.com/documentation/video_resizing_and_cropping>
- **Higgsfield `clipify`** — a productised "YouTube → 9:16 with face-tracking crop and styled burned-in subtitles" (per `live-provider-probe.md`). Evidence that this stage is buyable.

**(c) Roll it yourself with `sendcmd` — [MEASURED], and this is the good option.**
`crop`'s `x`/`y` are runtime-settable via the `sendcmd` filter, so you can drive a **per-frame crop path** computed by any tracker (face/object detection, saliency) without touching ffmpeg internals.

```
# crop.cmd — one line per keyframe time
0.00 crop x 200;
0.10 crop x 210;
0.20 crop x 220;
…
```
```
ffmpeg -i src_1920x1080.mp4 -vf \
  "sendcmd=f=crop.cmd,crop=w=608:h=1080:x=200:y=0,scale=1080:1920,setsar=1" \
  -c:v libx264 -pix_fmt yuv420p out_9x16.mp4
```
**[MEASURED]** produced `1080x1920 [SAR 1:1 DAR 9:16]`, and frames 0 and 110 differ by a mean absolute luma of 112 — i.e. the crop window genuinely moved. ✔

Engineering notes that make the difference between this looking professional and looking broken:
- **Crop width for 9:16 from 1080 height** is `1080 × 9/16 = 607.5` → use **608** (even). Odd dimensions are rejected by libx264 (§12.3).
- **Smooth the path.** Raw per-frame detections jitter. Low-pass the crop centre (EMA with α ≈ 0.1, or a 1-D Kalman) and **clamp velocity** to ~15 px/frame so it reads as a camera pan, not a glitch.
- **Emit commands at 5–10 Hz, not per frame.** `sendcmd` interpolates nothing, but at 10 Hz with a smoothed path the steps are invisible and the command file stays small.
- **Clamp to frame:** `x ∈ [0, W−crop_w]`.
- Detection can be anything — OpenCV Haar/DNN face detection, a YOLO person/product box, or a VLM asked for a bounding box on a sampled frame every 0.5 s. The *tracker* is swappable; `sendcmd` is the stable interface.

**Strategic point:** all of this is only necessary if you generate 16:9. **Generate 9:16 natively and this stage mostly disappears** — 9:16→4:5 and 9:16→1:1 are centre crops that keep 70% and 56% of the height respectively, and the subject is already framed for vertical.

### 12.6 The Meta-compliant encode

**[MEASURED]** produces a conformant file:
```
ffmpeg -i assembled.mp4 \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -x264-params "keyint=60:min-keyint=60:scenecut=0:bframes=2:ref=3" \
  -r 30 -b:v 8M -maxrate 10M -bufsize 16M \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart -video_track_timescale 30000 \
  master_9x16.mp4
```
Yielding: `Video: h264 (High) … yuv420p(progressive), 1080x1920 [SAR 1:1 DAR 9:16], 8106 kb/s, 30 fps, 30 tbr, 30k tbn` / `Audio: aac (LC) … 48000 Hz, stereo, 127 kb/s`.

Field-by-field justification against Meta's stated requirements (`meta-video-creative.md` §1.6):
| Flag | Requirement it satisfies |
|---|---|
| `-profile:v high` | *"H.264 compression"*; High profile is what Meta transcodes from |
| `-pix_fmt yuv420p` | *"4:2:0 chroma subsampling"*. Generative models frequently emit yuv444p or 10-bit → error **352 "Unsupported video format"** |
| `setsar=1` upstream | *"square pixels"* |
| `-r 30` | *"fixed frame rate"* — VFR is the #1 cause of "uploaded fine but audio drifts" |
| `keyint=60:min-keyint=60:scenecut=0` | *"closed GOP"*, deterministic 2 s keyframe interval |
| `-c:a aac -b:a 128k -ar 48000 -ac 2` | *"stereo AAC … at 128kbps+"*, 48 kHz max |
| `-movflags +faststart` | *"moov atom at the front of the file"* |
| `-video_track_timescale 30000` | integer timescale; avoids fractional-timebase rounding on concat |
| (not set) | *"Videos should not contain edit lists or special boxes in file containers"* — see gotcha below |

**[MEASURED] `+faststart` verified by reading the box order directly:**
```
with    +faststart : ftyp(32) moov(12612) free(8) mdat(11323290)
without +faststart : ftyp(32) free(8)      mdat(6786382) moov(12901)
```
A 20-line box-order check belongs in your QA gate (§14.1) — this is exactly the kind of thing that passes local playback and fails ingestion.

**Edit lists (`elst`):** Meta says the container must not contain them. ffmpeg writes an `elst` in some situations (notably when the first audio or video sample has a non-zero start offset, common after trimming). `-movflags +faststart` does not remove it. If you see ingestion problems, add `-avoid_negative_ts make_zero` and, on the final mux, consider `-movflags +faststart+empty_moov` **[UNVERIFIED for Meta compatibility — test before adopting]**. The reliable prevention is to ensure every stream starts at PTS 0, which a full re-encode from a filter graph (as above) already does.

**Bitrate:** Meta allows up to 100 Mbps VBR and 4 GB. Both are irrelevant — Meta re-transcodes everything, so anything above ~10–12 Mbps at 1080×1920 is pure upload latency. **Target 8 Mbps; cap the deliverable at ~200 MB.**

### 12.7 ffprobe assertions to run on every deliverable

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,pix_fmt,width,height,sample_aspect_ratio,r_frame_rate,avg_frame_rate,nb_frames \
  -show_entries format=duration,size,format_name -of json in.mp4
```
Assert: `codec_name=="h264"`, `profile=="High"`, `pix_fmt=="yuv420p"`, `sample_aspect_ratio=="1:1"`, `r_frame_rate==avg_frame_rate` (CFR), audio `codec_name=="aac" && sample_rate=="48000" && channels==2`, `format.size < 200e6`, and `moov` precedes `mdat`.

---

## 13. Stage 13: the render matrix

From `meta-video-creative.md` §7.5, the mapping that matters:

| Cut | Dimensions | Derivation from the 9:16 master | Placements |
|---|---|---|---|
| **9:16** | 1080×1920 | master | IG reels/story/profile_reels; FB facebook_reels/story; threads_stream |
| **4:5** | 1080×1350 | centre crop (keeps 70% of height) | FB feed; IG stream/profile_feed |
| **1:1** | 1080×1080 | centre crop (keeps 56% of height) | facebook_reels_overlay (**4–15 s only**), marketplace, video_feeds, search, ig_search, explore |
| **16:9** | 1920×1080 | **do not derive** — regenerate if you buy in-stream | audience_network/facebook instream_video |

**The subject-safety rule for derived cuts:** the master must be composed so the subject sits inside the **1:1 centre band** — vertically, `y ∈ [420, 1500]` on a 1080×1920 canvas. Put that constraint in the *keyframe prompt* ("subject centred, full subject within the central square of the frame") and the crops become free. This is far cheaper than fixing it with saliency tracking afterwards, and it is the single highest-leverage instruction in the whole image-prompt template.

**Aspect ratio tolerance is 1%** and minimum width is **250 px (<30 s) / 500 px (≥30 s)** per Meta's Reels/Stories pages — trivially satisfied at 1080, but assert it anyway for any low-res fallback path.

---

## 14. Stage 14: QA gates before publish

Every gate below was run in this environment; the output strings are what you actually parse.

### 14.1 Container / conformance

Per §12.7 plus the box-order check:
```python
import struct
def top_level_boxes(path, n=8):
    out, off = [], 0
    with open(path,'rb') as f:
        for _ in range(n):
            f.seek(off); hdr = f.read(8)
            if len(hdr) < 8: break
            sz = struct.unpack('>I', hdr[:4])[0]; typ = hdr[4:8].decode('latin1')
            out.append(typ)
            if sz == 1: sz = struct.unpack('>Q', f.read(8))[0]
            if sz == 0: break
            off += sz
    return out
assert top_level_boxes(p).index('moov') < top_level_boxes(p).index('mdat')   # faststart
```

### 14.2 Black frames, freezes, silence

**[MEASURED]** against a deliberately defective file (1 s of black head):

```
$ ffmpeg -i defective.mp4 -vf "blackdetect=d=0.2:pic_th=0.98:pix_th=0.10" -f null -
[blackdetect @ …] black_start:0 black_end:1.033333 black_duration:1.033333

$ ffmpeg -i defective.mp4 -vf "freezedetect=n=0.001:d=0.5" -f null -
[freezedetect @ …] lavfi.freezedetect.freeze_start: 0
[freezedetect @ …] lavfi.freezedetect.freeze_duration: 1.033333
[freezedetect @ …] lavfi.freezedetect.freeze_end: 1.033333

$ ffmpeg -i defective.mp4 -af "silencedetect=n=-50dB:d=0.5" -f null -
[silencedetect @ …] silence_start: 0
[silencedetect @ …] silence_end: 1.021354 | silence_duration: 1.021354
```

Filter defaults, **[MEASURED]**:
- `blackdetect`: `d`/`black_min_duration` default **2** s; `pic_th`/`picture_black_ratio_th` default **0.98**; `pix_th`/`pixel_black_th` default **0.1**. Lower `d` to 0.2 for ads — a 2 s default will miss a black *first frame*, which is the failure that actually matters.
- `freezedetect`: `n`/`noise` default 0.001, `d`/`duration` default 2 s.
- `silencedetect`: `n` default 0.001, `d` default 2 s, `mono` bool.
- `blackframe`: `amount` default 98 (% of pixels), `threshold`/`thresh` default 32 (0–255).

**Gate policy for a 15–30 s ad:**
| Check | Fail condition |
|---|---|
| First frame black | `YAVG < 20` on frame 0 |
| Any black run | `black_duration > 0.25` anywhere |
| Freeze | `freeze_duration > 0.6` (a held product beauty shot is legitimate; 2 s is not) |
| Silence | `silence_duration > 1.5` anywhere in the first 90% of the ad |
| Duration | within ±0.15 s of `target_seconds` **and** inside the placement's allowed range (note `facebook_reels_overlay` is **4–15 s**) |

### 14.3 The limited-range black trap

**[MEASURED]** first-frame luma of a true-black frame:
```
$ ffmpeg -i defective.mp4 -vf "select=eq(n\,0),signalstats,metadata=print:key=lavfi.signalstats.YAVG" -frames:v 1 -f null -
[Parsed_metadata_2 @ …] lavfi.signalstats.YAVG=16
```
**Black is 16, not 0**, because H.264 video is limited-range (TV range, Y ∈ [16,235]) by default. A gate written as `YAVG < 5` never fires. Use `< 20`. The same off-by-16 catches people writing white-flash detectors (`YAVG > 235` never fires either; white is 235).

### 14.4 Safe-zone text overlap detection

The most valuable visual gate, because the failure is invisible in your player and obvious in the Reels UI. Method: **render the overlay layer alone onto black, then measure the bounding box of non-black pixels.** This isolates *your* text from the generated imagery, so there are no false positives from bright scene content.

**[MEASURED]** full working gate:
```python
import numpy as np, glob
from PIL import Image
W, H = 1080, 1920
# Meta strict safe zone: 14% top, 35% bottom, 6% each side
sx0, sx1 = int(0.06*W), int(W - 0.06*W)      # -> 64, 1015
sy0, sy1 = int(0.14*H), int(H - 0.35*H)      # -> 268, 1248
for f in sorted(glob.glob("layer_*.png")):
    a = np.array(Image.open(f).convert("L"))
    ys, xs = np.nonzero(a > 16)
    if not len(xs): continue
    bx0, bx1, by0, by1 = xs.min(), xs.max(), ys.min(), ys.max()
    viol = []
    if bx0 < sx0: viol.append(f"left by {sx0-bx0}px")
    if bx1 > sx1: viol.append(f"right by {bx1-sx1}px")
    if by0 < sy0: viol.append(f"top by {sy0-by0}px")
    if by1 > sy1: viol.append(f"bottom by {by1-sy1}px")
    if viol: raise SafeZoneViolation(f, (bx0,by0,bx1,by1), viol)
```
Layer render:
```
ffmpeg -f lavfi -i "color=c=black:s=1080x1920:r=30:d=<dur>" -vf "ass=overlay.ass" -q:v 2 layer_%03d.png
```
**[MEASURED] results:** with `MarginV: 672` the caption bbox was `(223,1187)–(859,1234)` → **no violations across 180 frames**. With `MarginV: 60` the bbox was `(223,1799)–(859,1846)` → **violates bottom by 598 px**, i.e. sitting squarely under the Reels action rail and CTA sheet.

Safe box on 1080×1920 is **x ∈ [64, 1015], y ∈ [268, 1248] — 951 × 980 px**. That is only **25% of the canvas area**. Design to it from the start; you cannot retrofit it.

### 14.5 Loudness gate
```
ffmpeg -nostats -i out.mp4 -filter_complex ebur128=peak=true -f null -
```
**[MEASURED]** prints a parseable summary block:
```
  Integrated loudness:
    I:         -14.0 LUFS
    Threshold: -24.0 LUFS
  Loudness range:
    LRA:         0.6 LU
  True peak:
    Peak:      -20.0 dBFS
```
Gate: `-16.0 ≤ I ≤ -12.0` and `Peak ≤ -1.0 dBFS`.

### 14.6 Brand-safety and policy screening with a VLM

Sample frames at 1 fps (a 24 s ad = 24 frames; at Gemini's 1,120 tokens/image that is ~27 k input tokens ≈ **$0.02** on `gemini-3.7-flash` at $0.75/1M in). Ask for **structured output**, never prose:

```json
{
  "contains_text": ["WASHING IT WRONG?", "Shop now"],
  "brands_visible": ["<advertiser>"],
  "people": {"count": 1, "apparent_minors": false, "skin_exposure": "low"},
  "prohibited_content": {"weapons": false, "alcohol": false, "medical_claims": false,
                         "before_after_body": false, "shocking_imagery": false},
  "product_matches_reference": true,
  "text_legible": true,
  "artifacts": {"extra_fingers": false, "melted_text": false, "warped_faces": false}
}
```
Route on it:
- `brands_visible` containing anything but the advertiser → **hard reject** (IP path; see `meta-policy-compliance.md` on `dri_copyright`/`dri_counterfeit`, where a hit is a rights-holder complaint, not a classifier, and should halt the whole creative *lineage*).
- `before_after_body`, `medical_claims`, `apparent_minors` → hard reject, no retry.
- `artifacts.*` → retry with a new seed.
- `text_legible == false` → the caption/overlay stage failed; re-render overlays only (cheap).

Also run **OCR on sampled frames and diff against the intended overlay strings**. Generated imagery loves to hallucinate signage; text you did not author appearing in frame is both a quality bug and a trademark risk.

### 14.7 Automated preview rendering

Two artifacts per deliverable, both cheap:
1. **Contact sheet** — `-vf "fps=1,scale=270:-1,tile=6x5"` → one PNG showing the whole ad. This is what a human reviews when the pipeline escalates, and what you attach to an alert.
2. **Meta's own preview** — `POST /act_{id}/generatepreviews` renders the ad *inside the real placement chrome*. This is the only way to see whether your text actually collides with the UI on each placement. (Details in `meta-video-creative.md` §11; note v26.0 removed poll components from this endpoint.)

Render the contact sheet **before** upload; fetch the Meta preview **after** creative creation but **before** the ad goes to `ACTIVE`.

---

## 15. Determinism and reproducible renders

The requirement: given a `shotlist_id`, re-running the pipeline must produce a byte-identical (or at minimum, perceptually identical and QA-equivalent) deliverable, and changing one shot must re-render only that shot.

### 15.1 Content-addressed storage

Every artifact is stored at `cas/<sha256>` and referenced by hash. Provider URLs are **never** persisted — they expire (FLUX **10 minutes**, MiniMax ~24 h, ByteDance 7 days) and are explicitly not for serving.

### 15.2 The cache key

The cache key for a stage is the hash of everything that could change its output:
```
key = sha256(canonical_json({
  "stage": "keyframe",
  "provider": "bfl", "model": "flux-2-pro",   # PIN THE VERSION, never "-preview"/"-latest"
  "prompt": ..., "negative_prompt": ...,
  "refs": ["cas:sha256:…"],                    # by content, not by URL
  "params": {"width":1080,"height":1920,"seed":1734029},
  "pipeline_version": "creative@3.11.0"
}))
```
Four rules that make this actually work:
1. **Canonical JSON** — sorted keys, no whitespace, fixed float formatting. Otherwise the key churns on serialisation order.
2. **Pin model versions.** BFL explicitly distinguishes `flux-2-pro-preview` (*"reflects our latest advances"*) from `flux-2-pro` (*"a pinned model"*). A `-preview` or `-latest` alias makes your cache key a lie the moment the vendor ships. Same for `seedream-5-0-260128` vs a floating alias.
3. **Include `pipeline_version`.** A change to your prompt template must invalidate the cache even though the user-visible inputs did not change.
4. **Reference by content hash, not URL.** Two identical product photos uploaded twice must hit the same cache entry.

### 15.3 What is actually deterministic

| Stage | Deterministic? | Mechanism |
|---|---|---|
| LLM script/storyboard | **No** — treat as non-deterministic even at temperature 0 | **Persist the output**, don't try to reproduce it. The ShotList *is* the record |
| Image gen | Partially | `seed` on FLUX / Seedream / most models. Same seed + same model version usually reproduces; vendors do not guarantee it across serving-stack changes |
| Video gen | Partially | Seedance takes `--seed` (rides in the prompt string, see gotcha §18); Veo's determinism **[UNVERIFIED]** |
| **TTS** | **Yes** | ElevenLabs `seed` (0–4294967295) |
| Music | Partially | **[UNVERIFIED]** — no seed field documented for ElevenLabs Music or MiniMax Music |
| Forced alignment | Yes | deterministic given the same audio |
| **ffmpeg assembly** | **Yes, with care** | see below |

**Making ffmpeg reproducible:** x264 is deterministic for a given version + settings + input, but the *container* is not, because ffmpeg stamps metadata. Add:
```
-fflags +bitexact -flags:v +bitexact -flags:a +bitexact -map_metadata -1
```
This strips the encoder string and creation time. Without it, two identical renders differ in bytes and your content-addressed store fills with duplicates. **[UNVERIFIED]** whether `+bitexact` output is fully byte-identical across x264 *builds* — pin the ffmpeg/x264 version in the render image and treat a version bump as a cache invalidation event.

### 15.4 The render manifest

Emit alongside every deliverable; this doubles as the provenance ledger required by `meta-policy-compliance.md`:
```json
{
  "deliverable": "cas:sha256:…", "shotlist_id": "sha256:…",
  "pipeline_version": "creative@3.11.0",
  "ffmpeg": {"version":"7.0.2","x264":"…","filters_used":["ass","xfade","loudnorm","scale","crop","setsar"]},
  "stages": [
    {"stage":"keyframe","shot":"s1","provider":"bfl","model":"flux-2-pro",
     "seed":1734029,"cache_hit":false,"cost_usd":0.045,"latency_ms":8210,
     "output":"cas:sha256:…","refs":["cas:sha256:…"]},
    {"stage":"vo","provider":"elevenlabs","model":"eleven_v3","voice_id":"…",
     "seed":991,"cost_usd":0.035,"output":"cas:sha256:…"}
  ],
  "licences": [{"asset":"cas:sha256:…","source":"elevenlabs_music_v2","cleared_for":["paid_social_ads"]}],
  "qa": {"loudness_lufs":-14.0,"true_peak_dbfs":-1.2,"safe_zone":"pass",
         "black_frames":0,"vlm_screen":"pass","duration_s":24.03},
  "cost_usd_total": 2.94, "wall_clock_s": 214
}
```

### 15.5 Partial re-render — the economic point

Because shots are independently cached, the marginal cost of a **variant** is only the changed shots:

| Change | Re-rendered | Cost of a $2.95 ad's variant |
|---|---|---|
| New hook line (shot 1 only) | 1 keyframe + 1 clip + VO + assembly | **~$1.05** |
| New CTA text only | overlay + assembly | **~$0.01** |
| New aspect ratio | assembly only | **~$0.00** |
| New price in copy | overlay + VO + assembly | **~$0.04** |
| New angle | everything | $2.95 |

**This table is the reason the pipeline is worth building.** A creative-testing loop that can produce 20 hook variants for the price of 7 full ads is a fundamentally different economic object from one that regenerates from scratch. Design the shot list so **shot 1 is always the hook and always independently swappable** — no cross-shot conditioning into shot 1, and no last-frame chaining *out of* shot 1 into shot 2 (use a shared style reference instead).

---

## 16. Cost and latency per finished ad

### 16.1 Assumptions

24-second ad, 9:16 1080×1920, 3 shots × 8 s (or 6 × 4 s at the same video cost), ~60 words of VO (~350 chars), music bed, burned-in captions, 3 aspect-ratio deliverables. Video generated **audio-off** (we synthesise our own), which halves Veo 3.1 on Vertex.

### 16.2 Per-tier cost model

| Line item | **Volume** | **Standard** | **Hero** |
|---|---|---|---|
| Brief→script→storyboard (LLM) | `gemini-3.7-flash`, ~8k in/3k out → **$0.017** | $0.017 | `gemini-3.1-pro`, **$0.09** |
| Keyframes (3) | NB2 Lite @1K, 3×$0.0336 → **$0.10** | NB Pro @1K, 3×$0.134 → **$0.40** | NB Pro @4K, 3×$0.24 → **$0.72** |
| Product-fidelity edits | — | 2 FLUX.2 pro edits @$0.045 → **$0.09** | 3 edits + 1 inpaint → **$0.18** |
| Video (24 s, audio-off) | Veo 3.1 **Lite** 720p @$0.03/s → **$0.72** | Veo 3.1 **Fast** 1080p @$0.10/s → **$2.40** | Veo 3.1 1080p @$0.20/s → **$4.80** |
| Voiceover | `tts-1` 350 ch → **$0.005** | `eleven_flash_v2_5` → **$0.018** | `eleven_v3` → **$0.035** |
| Music (24 s) | reuse cached bed → **$0.00** | ElevenLabs Music $0.15/min → **$0.06** | **$0.06** |
| Forced alignment | Deepgram/whisper → **$0.002** | $0.002 | WhisperX self-host → **$0.001** |
| QA VLM (24 frames) | 6 frames → **$0.006** | 24 frames → **$0.02** | 24 frames, Pro → **$0.08** |
| ffmpeg compute (all passes + 3 ratios) | **~$0.005** | ~$0.005 | ~$0.008 |
| **Subtotal (no retries)** | **$0.855** | **$3.01** | **$5.98** |
| Retry multiplier (empirical guess) | ×1.2 | ×1.0 (rejects caught at keyframe) | ×1.4 (higher bar) |
| **Realistic total** | **≈ $1.03** | **≈ $3.01** | **≈ $8.37** |

Price sources: Veo/Gemini from `video-gen-google-veo.md` §5 (<https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>); FLUX from <https://docs.bfl.ml/quick_start/pricing.md>; ElevenLabs from <https://elevenlabs.io/pricing/api>; OpenAI from <https://developers.openai.com/api/docs/pricing>; Deepgram from <https://deepgram.com/pricing>.

**Alternative video stacks at the same 24 s:**
| Stack | Math | Cost |
|---|---|---|
| FLUX 3 i2v **draft** | 24 × $0.06 | **$1.44** |
| FLUX 3 i2v hd | 24 × $0.17 | $4.08 |
| FLUX 3 i2v fhd | 24 × $0.29 | $6.96 |
| Gemini Omni Flash 1080p | 24 × $0.152 | $3.65 |
| Veo 3.1 Fast 1080p **with** audio | 24 × $0.12 | $2.88 |

**Note the FLUX 3 draft tier at $1.44 for 24 s of hd video.** For the exploration phase — where you render 10 angles and keep 2 — drafts are the correct instrument, and only the survivors get a full render. That is a ~3× saving on the dominant cost line.

### 16.3 Latency

| Stage | Wall clock | Parallelisable |
|---|---|---|
| Script + storyboard | 5–20 s | no |
| Keyframes ×3 | 8–30 s each | **yes** → ~30 s |
| Fidelity edits | 8–20 s each | yes |
| Video ×3 (8 s clips) | 60–240 s each | **yes** → ~240 s worst case |
| VO | 1–5 s (Flash TTFB ~75 ms) | yes |
| Music | 30 s – several minutes (MiniMax music is **synchronous**, ~20 concurrent connections max) | yes |
| Alignment | 2–10 s | — |
| Assembly (all filters) | **[MEASURED]** ffmpeg ran the filter passes at ~18× realtime; a 24 s ad's full chain incl. 3 ratio derivations ≈ **20–40 s** | partly |
| QA gates | 10–20 s | yes |
| Meta upload + processing | see `meta-video-creative.md` §2 | no |

**Critical path ≈ 5–7 minutes** with per-shot parallelism; **12–20 minutes** serial. The single biggest latency lever is **shot-level parallelism in video generation** — build the orchestrator around a fan-out/fan-in over shots from day one, because retrofitting it means rewriting the assembly stage.

**Throughput warning:** MiniMax music is synchronous with ~20 concurrent connections; ElevenLabs concurrency limits per tier are **[UNVERIFIED]** (the docs page 404s) but are real and tier-scaled. At 1,000 ads/day you will hit provider concurrency before you hit cost limits. Queue per-provider with explicit concurrency caps and exponential backoff on 429.

---

## 17. Gotchas

Ranked roughly by cost-when-hit. Every one is verified above unless marked.

1. **`pad` after `scale=…force_original_aspect_ratio` yields non-square pixels.** **[MEASURED]** `SAR 2025:2024`. Meta requires square pixels. **Always end geometry chains with `setsar=1`.** (§12.3)
2. **`scale` with `force_original_aspect_ratio` can produce odd dimensions and libx264 hard-fails**: `width not divisible by 2 (759x1350)`. Use `force_divisible_by=2`. (§12.3)
3. **Single-pass `loudnorm` outputs 192 kHz.** **[MEASURED]** Meta's ceiling is 48 kHz. Two-pass with `linear=true` preserves 48 kHz; always also append `aresample=48000`. (§12.4)
4. **`drawtext` requires libharfbuzz since FFmpeg n6.1** and is missing from common static builds even with `--enable-libfreetype`. **[MEASURED + SOURCE]** Build the whole text system on libass instead. (§11.5)
5. **`force_style` font sizes are scaled by `video_height / 288`.** FFmpeg's SRT→ASS default is `PlayResY 288`. **[MEASURED]** `Fontsize=24` rendered ~160 px on 1080×1920. Author real `.ass` with explicit `PlayResX/Y`. (§11.4)
6. **Word-level timestamps in the OpenAI API are `whisper-1`-only** and require `response_format: "verbose_json"`. The newer `gpt-transcribe` family does not support `timestamp_granularities`. (§11.2)
7. **`xfade` `offset` is on the accumulated output timeline**, and transitions shorten the ad: `total = Σd − Σt`. **[MEASURED]** 3×4 s with 2×0.5 s → 11.03 s. (§12.2)
8. **`cropdetect` is not a subject detector.** **[MEASURED]** returns the full frame on non-letterboxed content. Use `sendcmd`-driven `crop` with an external tracker. (§12.5)
9. **Limited-range black is Y=16, not 0.** **[MEASURED]** `YAVG=16` on a black frame. A `YAVG < 5` gate never fires; white is 235, not 255. (§14.3)
10. **`+faststart` is not the default.** **[MEASURED]** without it, `moov` lands after `mdat`. Meta requires moov at the front. (§12.6)
11. **Generative video models emit yuv444p / 10-bit.** Meta wants 4:2:0 and returns **error 352 "Unsupported video format"**. Force `-pix_fmt yuv420p`.
12. **Provider URLs expire fast — FLUX in 10 minutes.** *"Generated images expire after 10 minutes and become inaccessible."* Also no CORS, and explicitly not for direct serving. Download inside the polling loop. MiniMax ~24 h; ByteDance 7 days.
13. **Seedance video parameters ride inside the prompt string**, not as JSON fields: `--duration`, `--resolution`, `--ratio`, `--seed`, `--watermark` are appended to the prompt text. **[SOURCE: `modelark/scripts/ark.py`]** Hand-writing this is a reliable way to lose an afternoon.
14. **Seedance duration is per-model with no universal default.** A value one model accepts, another rejects with `InvalidParameter`; that error means "try a different number", not "the model is broken".
15. **BytePlus `GET /models` lists models the key cannot call.** They fail with `InvalidEndpointOrModel.NotFound` at invoke time. Probe with a deliberately invalid request and read the error code (free — it dies in validation).
16. **No video model in the live catalogue generates 4:5 natively**, which is Meta's recommended Feed ratio. Static image models do. Statics and video are therefore different generation paths, not one with a ratio parameter. (`live-provider-probe.md`)
17. **Veo and Gemini Omni are 16:9/9:16 only.** They can never produce your 1:1 or 4:5 cut directly.
18. **Turning audio off halves Veo 3.1's price — but only on Vertex's price sheet.** The Gemini Developer API lists no audio-off discount.
19. **MiniMax H3 forces `ratio` to adaptive when you pass an image**, so your keyframe's aspect ratio silently becomes the clip's.
20. **MiniMax v1 endpoints return HTTP 200 on failure** — you must check `base_resp.status_code` (0 = success; 1002 rate limit, 1008 balance, 1026 sensitive content, 2013 bad params).
21. **Suno's paid-tier assignment is not a warranty.** *"Suno makes no representation or warranty to you that any copyright will vest in any Output"*, and you indemnify Suno. (§10.2)
22. **Meta Sound Collection audio cannot be used off Meta.** Silent contract breach for any multi-channel platform. (§10.1)
23. **Native audio from a video model has no licence record.** Strip it (`-an`) and replace. (§10.3)
24. **Instant voice cloning is self-attested; professional voice cloning is self-only** (*"Even with their consent, you cannot clone someone else's voice"*) and has a 24-hour retry lockout on failed verification. It cannot be a fully automated feature. (§9.3)
25. **SynthID is unconditional on Gemini image output** and you may not strip provenance markings. (`meta-policy-compliance.md`)
26. **ffmpeg strips C2PA.** A Veo→ffmpeg→Meta pipeline arrives with no provenance manifest. That is a marking problem, not a clean file. (`meta-policy-compliance.md` §4.7)
27. **The safe-zone box is only 25% of the canvas** (951×980 of 1080×1920). Compose to it from the keyframe prompt onward.
28. **`facebook_reels_overlay` is 1:1 and 4–15 s only.** A 24 s ad is ineligible for that placement regardless of how you crop it.
29. **`asplit` is mandatory in a sidechain duck** or the compressor eats the voiceover it is keyed on. (§10.4)
30. **Fonts are not present in your render container.** This one had 59 fonts and no Inter/Helvetica/Arial. Bake brand fonts into the image and reference by absolute path.
31. **`concat` demuxer with `-c copy` requires byte-level parameter identity** across clips from different models. Always re-encode. (§12.1)
32. **`zoompan` computes its crop at source resolution** and visibly steps. Upscale ~4× with lanczos first — **[MEASURED]** it was not slower. (§8.4)
33. **`-fflags +bitexact -map_metadata -1`** is required for reproducible bytes; otherwise ffmpeg stamps encoder and creation time and your CAS fills with duplicates. (§15.3)
34. **ASS colours are `&HAABBGGRR`** — BGR order with inverted alpha (`00` = opaque) — and booleans are `-1`/`0`. Write a converter or lose 30 minutes per brand.

---

## 18. Open questions / UNVERIFIED

**Pricing and limits I could not confirm**
1. **Google Cloud Text-to-Speech per-character pricing** for Standard / WaveNet / Neural2 / Studio / Chirp3 HD / Gemini TTS — the pricing page is client-rendered and returned no figures.
2. **Azure AI Speech TTS pricing** — the pricing table renders `$-` placeholders. Custom Professional Voice additionally bills training compute-hours and per-model-per-hour endpoint hosting.
3. **Cartesia pricing and its actual latency figures.** Models confirmed (`sonic-3.6`, `sonic-3.5`, `sonic-3`, `sonic-latest`) and the endpoint (`POST https://api.cartesia.ai/tts/bytes`), but the docs state no latency claim.
4. **MiniMax TTS (`/v1/t2a_v2`) and Music (`music-3.0`) pricing.**
5. **ElevenLabs per-tier concurrency limits** — `elevenlabs.io/docs/api-reference/limits` 404s. These are real and will bind before cost does at scale.
6. **AssemblyAI: whether word-level timestamps are included in the base rate** or are a stacking add-on.
7. **Epidemic Sound's partner/API programme** — `epidemicsound.com/partner/api/` 404s and `partners.epidemicsound.com` does not resolve. Whether a programmatic licensed-music path exists at all is unresolved, and it matters: it is the "boring correct answer" for regulated verticals.
8. **Bria's exact endpoint paths and request fields** for packshot / lifestyle-shot / shadow, and its licensed-data / indemnification claims. The docs index confirms 21 v2 image-editing endpoints exist but did not enumerate them.

**Technical questions**
9. **Google Lyria 2 / Lyria 3**: model ids beyond `lyria-002` / `lyria-3`, endpoint, request shape, output format/duration, SynthID behaviour — and critically **whether Lyria is covered by Vertex's generative-AI indemnification**. If it is, it becomes the default music source and §10's risk ranking changes.
10. **Veo determinism**: is there a seed parameter, and is output reproducible across serving-stack changes?
11. **Music generation seeds**: no seed field is documented for ElevenLabs Music or MiniMax Music. If none exists, music is permanently non-reproducible and must be treated as a stored asset, never a regenerated one.
12. **Whether `+bitexact` output is byte-identical across different x264 builds.** Assumed no; pin the render image.
13. **Whether `-movflags +faststart+empty_moov` is Meta-ingestion-safe**, and the precise conditions under which ffmpeg emits an `elst` edit list (which Meta's spec forbids).
14. **Meta's actual loudness expectation.** −14 LUFS is a streaming convention, not a documented Meta requirement; whether Meta normalises on ingest is unknown.
15. **Whether Meta's `generatepreviews` renders burned-in captions faithfully** enough to serve as the safe-zone gate, which would let you drop the pixel-level detector in §14.4.
16. **ElevenLabs Music Commercial Rights table** — the per-plan table is referenced repeatedly in the terms but did not render. The headline claim (*"cleared for nearly all commercial uses… from advertisements to gaming"*) needs to be checked against the actual per-tier table before it is relied on.

**Legal**
17. **US state synthetic-voice / right-of-publicity statutes** (Tennessee ELVIS Act and successors) and any 2026 federal action. Not researched. A platform offering voice cloning is the plausible defendant, not the advertiser.
18. **Whether the EU AI Act Art. 50(2) marking obligation** falls on this platform as a deployer when it re-encodes provider output and strips C2PA. See `meta-policy-compliance.md` §4.7.

---

## 19. Implementation checklist

- [ ] ShotList JSON schema with duration validation against each provider's allowed set, enforced **before** any billable call
- [ ] Content-addressed store; provider URLs downloaded inside the polling loop (FLUX: 10-minute window)
- [ ] Per-stage cache keyed on canonical JSON incl. **pinned** model version + `pipeline_version`
- [ ] Fan-out/fan-in orchestrator over shots, with per-provider concurrency caps and 429 backoff
- [ ] Keyframe VLM gate (product match, OCR, ΔE, extra-logo hard-reject) **before** paying for motion
- [ ] Composite path (background removal → harmonise → overlay) as the tier-1 product-fidelity strategy
- [ ] TTS with `seed`, `previous_text`/`next_text`, PCM/WAV 48 kHz intermediates; round-trip ASR verification
- [ ] Music provenance record required; **build fails without a licence reference**
- [ ] Forced alignment → generated `.ass` with `PlayResX/Y` = video dimensions, `MarginV = 0.35 × height`
- [ ] Assembly: normalise → concat filter (re-encode) → overlays → two-pass loudnorm + `aresample=48000` → Meta encode with `setsar=1` and `+faststart`
- [ ] Ratio derivation: 9:16 master → 4:5 / 1:1 centre crops, each terminated with `setsar=1`
- [ ] QA gates: ffprobe conformance, moov-before-mdat, blackdetect(d=0.2), freezedetect, silencedetect, ebur128, safe-zone bbox detector, VLM policy screen, contact sheet
- [ ] Render manifest emitted per deliverable, doubling as the provenance ledger
- [ ] Fonts baked into the render image; libass everywhere, `drawtext` nowhere

---

## Appendix — source index

**Official documentation**
- Meta ad video upload — <https://developers.facebook.com/docs/graph-api/reference/ad-account/advideos/>
- Meta AdCreativeVideoData — <https://developers.facebook.com/docs/marketing-api/reference/ad-creative-video-data/>
- Gemini image generation (Nano Banana) — <https://ai.google.dev/gemini-api/docs/image-generation>
- Google generative-AI pricing — <https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>
- BFL docs index — <https://docs.bfl.ml/llms.txt>
- BFL pricing — <https://docs.bfl.ml/quick_start/pricing.md>
- BFL FLUX.2 image editing — <https://docs.bfl.ml/flux_2/flux2_image_editing.md>
- BFL integration guide (polling, delivery URLs, 10-min expiry) — <https://docs.bfl.ml/api_integration/integration_guidelines.md>
- BFL product consistency — <https://docs.bfl.ml/guides/usecases_editing_product_consistency.md>
- BFL hex-colour prompting — <https://docs.bfl.ml/guides/usecases_t2i_hex_color_prompting.md>
- BFL image-to-video prompting — <https://docs.bfl.ml/guides/prompting_video_image_to_video.md>
- BFL Virtual Try-On — <https://docs.bfl.ml/flux_tools/flux_vto.md>
- ElevenLabs models — <https://elevenlabs.io/docs/models>
- ElevenLabs API pricing — <https://elevenlabs.io/pricing/api>
- ElevenLabs TTS endpoint — <https://elevenlabs.io/docs/api-reference/text-to-speech/convert>
- ElevenLabs instant voice cloning — <https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning>
- ElevenLabs professional voice cloning — <https://elevenlabs.io/docs/product-guides/voices/voice-cloning/professional-voice-cloning>
- ElevenLabs Music — <https://elevenlabs.io/docs/capabilities/music>, <https://elevenlabs.io/music-terms>, <https://elevenlabs.io/eleven-music-model-specific-terms>
- OpenAI pricing — <https://developers.openai.com/api/docs/pricing>
- OpenAI speech-to-text — <https://developers.openai.com/api/docs/guides/speech-to-text>
- Deepgram pricing — <https://deepgram.com/pricing>
- AssemblyAI pricing — <https://www.assemblyai.com/pricing>
- Cartesia TTS — <https://docs.cartesia.ai/api-reference/tts/bytes>
- Azure Speech pricing — <https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/>
- Suno terms — <https://suno.com/terms>
- Cloudinary video resizing/cropping — <https://cloudinary.com/documentation/video_resizing_and_cropping>
- WhisperX — <https://github.com/m-bain/whisperX>
- Meta IP / music policy — <https://transparency.meta.com/policies/ad-standards/intellectual-property-infringement/third-party-infringement/>

**Source code consulted directly**
- `https://raw.githubusercontent.com/FFmpeg/FFmpeg/{n5.1,n6.0,n6.1,n7.0,master}/configure` — `drawtext_filter_deps`
- `https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.0/libavcodec/ass.h` — `ASS_DEFAULT_PLAYRESX/Y`

**Local, in-session**
- `modelark` skill: `SKILL.md`, `references/models.md`, `scripts/ark.py` (verified BytePlus wire format)
- `minimax` skill: `references/api.md` (verified MiniMax endpoints and enums)
- Higgsfield MCP tool schemas: `reframe`, `remove_background`, `outpaint_image`, `generate_audio`
- ffmpeg `7.0.2-static` — all **[MEASURED]** results, 2026-09-02

**Sibling dossiers**
- `meta-video-creative.md`, `meta-policy-compliance.md`, `video-gen-google-veo.md`, `live-provider-probe.md`, `meta-api-foundations.md`, `meta-campaign-publishing.md`, `meta-insights-measurement.md`, `meta-optimization-controls.md`
