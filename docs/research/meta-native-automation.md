# Meta's Own Ad Automation — What Is Already Free

**Research date: 2026-09-02.** Every version number, field name, enum, endpoint and metric below was fetched live from the source on this date. Where I could not verify something, it is marked **UNVERIFIED** rather than guessed.

**Method note:** the session's search-engine budget was exhausted, so this was assembled by direct crawling of `developers.facebook.com` (which serves a machine-readable `.md` variant of every doc page — append `.md` to any `/documentation/...` path), `engineering.fb.com`, `about.fb.com`, `ai.meta.com`, `www.facebook.com/business/news`, plus Google News RSS (`https://news.google.com/rss/search?q=...`) as a search substitute. **Meta moved its ads docs IA**: the canonical path is now `https://developers.facebook.com/documentation/ads-commerce/marketing-api/...`. Old `/docs/marketing-api/<guide>` paths 404. The `/docs/marketing-api/reference/...` node reference pages still work.

---

## 0. TL;DR — the strategic picture in ten lines

1. Meta has **collapsed the "manual vs Advantage+" distinction**. As of v25.0 you can no longer create an Advantage+ Shopping Campaign or Advantage+ App Campaign at all; instead *any* `OUTCOME_SALES` / `APP_INSTALLS` / `OUTCOME_LEADS` campaign becomes "Advantage+" by satisfying three conditions (campaign-level budget, no placement targeting, Advantage+ audience). `advantage_state` is a **read-only derived flag**, not something you POST.
2. Meta's creative automation is **exactly 23 documented**, individually-toggleable transforms in `degrees_of_freedom_spec.creative_features_spec` (verified 2026-09-02 against the Get Started guide's feature table), **seven of which are explicitly "generated with AI"**: `creative_stickers`, `image_animation`, `image_background_gen`, `image_templates`, `image_uncrop`, `translate_voiceover`, `video_uncrop`. The node reference lists a further ~30 undocumented field names.
3. **Meta has NOT shipped text-to-video ad generation.** Its shipped video AI is image→animation, video uncrop, video filtering, voiceover translation, and photos→video slideshow. `Muse Video` (Meta Superintelligence Labs) is a *preview*, "coming soon to creators and Meta AI" — not to Ads Manager.
4. Meta ships its own **remote MCP server at `https://mcp.facebook.com/ads`** with **write** tools (create campaign/ad set/ad/creative/custom audience, activate). Opened to Claude/ChatGPT 2026-04-29; opened to any developer app 2026-07-16. A third-party "AI that runs your Meta ads" is now a commodity Meta gives away.
5. Meta ships an **Opportunity Score (0–100) on the AdAccount node** plus a `/recommendations` read **and apply** API, plus `ad_recommendations` and `creative_fatigue` webhooks. The "detect underperformance → recommend fix → apply fix" loop that most third-party tools sell **is a free first-party API**.
6. Meta's ranking stack (Andromeda retrieval, Lattice, GEM foundation model, Adaptive Ranking Model, multi-stage sequence models) is now genuinely LLM-scale and improving several % per quarter. **Do not try to out-target Meta.**
7. Meta charges **$0** for all of the above. There is no Advantage+ fee, no creative-generation fee, no MCP fee.
8. Meta's own AI optimises *its* objective function. It will happily spend your budget; it does not know your COGS, your contribution margin, your inventory, your LTV curve, or your cash position.
9. The residual third-party value is **not** targeting, **not** creative micro-transforms, and **not** "an AI that talks to the Ads API". It is: creative *origination* at volume with brand/product fidelity, cross-account priors, angle/offer strategy, margin-aware objective functions, funnel continuity, and multi-platform.
10. Meta's own docs impose a **mandatory human-review-before-publish norm on AI creative** ("Advertisers are responsible for previewing ad creative featuring AI-generated creatives before publishing"). Full autonomy is a policy risk surface, not just an engineering one.

---

## 1. API version landscape (as of 2026-09-02)

> **[FACT-CHECK CORRECTION 2026-09-02]** The original version of this section cited the Graph API changelog for the v24.0 sunset date. **The Marketing API and the Graph API publish two different expiration tables, and they disagree by ~16 months.** Read the Marketing API one. See the corrected tables below.

**Table A — Graph API versions.** Source: <https://developers.facebook.com/docs/graph-api/changelog>

| Version | Date Introduced | Available Until (Graph API) |
|---|---|---|
| **v26.0** | **2026-07-29** | TBD |
| v25.0 | 2026-02-18 | 2028-07-29 |
| v24.0 | 2025-10-08 | 2028-02-18 |
| v23.0 | 2025-05-29 | 2027-10-08 |
| v22.0 | 2025-01-21 | 2027-05-20 |

**Table B — Marketing API versions (THIS is the one that binds an ads platform).** Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/versions>

| Version | Release Date | **Expiration Date (Marketing API)** |
|---|---|---|
| **v26.0** | **2026-07-29** | TBD |
| v25.0 | 2026-02-18 | TBD |
| v24.0 | 2025-10-08 | **2026-10-06** — ~5 weeks from now |
| v23.0 | 2025-05-29 | **2026-06-09 — ALREADY EXPIRED** |
| v22.0 | 2025-01-21 | 2026-02-19 — expired |

The Marketing API is on a much shorter clock than the Graph API. Per <https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/versioning>: *"Marketing API is versioned on a 90-day deprecation schedule, whereas Platform API has core and extended APIs with a 2 year guarantee for core APIs."* and *"When a new version of the Marketing API releases, Meta continues to support the previous version of the Marketing API for at least 90 days."* In practice Marketing API versions have been living ~12 months, not 2+ years.

**Do not size your upgrade cadence off the Graph API table.** A build that reads "v24.0 available until February 2028" from the Graph API changelog and plans accordingly will break on 2026-10-06.

The Graph API changelog also states: *"Marketing API version auto-upgrade will be released on July 29, 2026."* — **build for v26.0 and expect to be force-upgraded.** Do not pin v24.0 for a system going live in Q4 2026.

### v26.0 Marketing API changes that matter to an autonomous platform
Source: <https://developers.facebook.com/docs/graph-api/changelog/version26.0>

- **Delivery Estimate gutted.** `daily_outcomes_curve`, `budget_guardrail` and `estimate_dau` are **removed** from `GET /{ad-account-id}/delivery_estimate` and `GET /{adset-id}/delivery_estimate` — *"because the service powering these values has been deprecated. **No replacement API is available.**"* Applies to all remaining supported versions on **2026-10-27**. If your budget planner was going to use Meta's outcome curve to pick a budget, **that data source is gone**; you must model it yourself from your own spend/result history.
- **HEC-F explicit `advantage_audience`.** For Housing / Employment / ~~Credit /~~ Financial-Products ad sets with relaxable targeting in a non-broad setup, omitting `targeting_automation.advantage_audience` now returns `ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG`. *(Fact-check 2026-09-02: the changelog text reads "Housing, Employment, or Financial Products" — **"Credit" was not found in the fetched text**. Treat the inclusion of Credit as UNVERIFIED.)*
- **Instagram Explore Feed placement removed** — explicitly specifying it errors.
- **Messenger Stories** (`messenger_positions: ["story"]`) silently stripped on v26.0+; all versions on 2026-10-27.
- **`applink_treatment=web_only`** can no longer be attached to an ad in a Website-and-App conversion-location campaign.
- **Poll ads removed**: `poll_spec` and the `poll` type under `interactive_components_spec` are unavailable.
- **Shops Ads defaulting**: *"Starting in API v26.0, eligible ad creatives will automatically default to `destination_spec.destination_type = WEBSITE_AND_SHOP` when the advertiser has a shop."* Opt out with `WEBSITE_AND_SHOP_OPT_OUT`. **This silently changes where your traffic lands.**
- Commerce Order Management API (47 endpoints) fully deprecated, no replacement.

---

## 2. Advantage+ campaigns — the 2025/2026 unification ("Advantage+ everything")

Primary source: **<https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-campaigns>** (page footer: *Updated: Jun 17, 2026*).

### 2.1 The old world is dead

Verbatim from the doc:

> "Beginning with v25.0, you will no longer be able to use the Advantage+ shopping campaign (ASC) API with the `smart_promotion_type=AUTOMATED_SHOPPING_ADS` field to create ASC campaigns, or the Advantage+ app campaign API with the `smart_promotion_type=SMART_APP_PROMOTION` field to create AAC campaigns."

> "With the introduction of v24.0, you will not be able to create ASC campaigns with `smart_promotion_type=AUTOMATED_SHOPPING_ADS`, but may revert to v23.0 to do so. The introduction of v25.0 will give an error for all attempts to create ASC campaigns with `smart_promotion_type=AUTOMATED_SHOPPING_ADS` **on any version of the API**."

> "All legacy ASC/AAC campaigns will be blocked from edits with the release of v26.0 and will no longer be able to use the `migrate_to_advantage_plus` field to migrate."

**Implication:** any tutorial, SDK sample, or blog post that tells you to POST `smart_promotion_type=AUTOMATED_SHOPPING_ADS` is dead code. Do not build it.

### 2.2 How you actually create an Advantage+ campaign now

There is **no** `advantage_state` you can POST. Verbatim FAQ:

> **"Can I use the `advantage_state` field to make a POST request to create an `ADVANTAGE_PLUS_SALES` campaign?"** — "No. Developers will need to follow the criteria above to make a campaign with Advantage+ audience, Advantage+ placement, and Advantage+ budget criteria."

You satisfy **three levers** and Meta derives the state:

**(a) Advantage+ placement state** — *"No placement targeting or exclusions should be set, so all available placements will be eligible."* All ad sets must comply, or the whole campaign reports `advantage_placement_state: DISABLED`. Account-level placement exclusions (via `/act_<ID>/account_controls`) are permitted and do **not** break eligibility. **This is the default in the API — no action needed to opt in.**

**(b) Advantage+ budget state** — budget set at **campaign** level (`daily_budget` or `lifetime_budget` on the Campaign node) with `bid_strategy` ∈ `LOWEST_COST_WITHOUT_CAP` (recommended), `COST_CAP`, `LOWEST_COST_WITH_BID_CAP`, `LOWEST_COST_WITH_MIN_ROAS`.

**(c) Advantage+ audience state** — at least one ad set must satisfy one of:
- `"targeting_automation": {"advantage_audience": 1}` (recommended), **or**
- no targeting parameters besides `geo_locations`, **or**
- individual targeting with relaxation enabled (Advantage Lookalike / Advantage Custom Audience / Advantage Detailed Targeting / age+gender as suggestions).

Exact qualification rule, verbatim:

> "If `"targeting_automation": {"advantage_audience": 1}` for at least one ad set in the campaign, **OR** if `"targeting_automation": {"advantage_audience": 0}` or is not set, and at least one ad set in the campaign has: Ad set is using default age or age <= 25 or using age as a suggestion; Ad set is using default gender or using gender as a suggestion; Ad set is not using custom audience inclusion or using Advantage custom audience"

### 2.3 Reading the state back

```
GET /v26.0/<CAMPAIGN_ID>?fields=name,objective,advantage_state_info
```

```json
{
  "advantage_state_info": {
    "advantage_state": "ADVANTAGE_PLUS_SALES",
    "advantage_budget_state": "ENABLED",
    "advantage_audience_state": "ENABLED",
    "advantage_placement_state": "ENABLED"
  }
}
```

`advantage_state` ∈ `ADVANTAGE_PLUS_SALES` (objective `OUTCOME_SALES`), `ADVANTAGE_PLUS_APP` (objective `APP_INSTALLS`; note the doc's response example labels the objective `APP_PROMOTION` — see Gotchas), `ADVANTAGE_PLUS_LEADS` (objective `OUTCOME_LEADS`), or `DISABLED`. **All four sub-fields are read-only.** If any one lever is `DISABLED`, `advantage_state` is `DISABLED`.

New Advantage+ campaigns report **`smart_promotion_type: GUIDED_CREATION`**. (The Campaign node reference at <https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/> still documents `smart_promotion_type` as *"guided_creation or smart_app_promotion"* — the reference lags the guide.)

**This is the single most useful assertion available to a third-party platform:** `advantage_state_info` is a free, first-party, per-campaign verdict on whether you have configured the account the way Meta's own optimiser wants. Poll it after every campaign write and alarm on `DISABLED`.

### 2.4 Migration endpoints (only useful for accounts you inherit)

```
POST <AD_CAMPAIGN_ID>/copies?migrate_to_advantage_plus=true   # copy + migrate
POST <AD_CAMPAIGN_ID>?migrate_to_advantage_plus=true          # migrate in place, keeps campaign ID
```

Response for copy: `{"copied_campaign_id": "...", "ad_object_ids": [{"ad_object_type":"campaign","source_id":"...","copied_id":"..."}]}`. Response for in-place: `{success: <BOOLEAN>}`.

Hard limits, verbatim:
- *"Advantage+ app campaigns can only be migrated, not copied, into the Advantage+ format."*
- *"Advantage+ shopping campaigns using `existing_customer_budget_percentage` cannot be migrated to the Advantage+ structure using the Marketing API."* (Ads Manager only.)
- *"ASC campaigns where the count of ads within the ASC adset is greater than 50 cannot be migrated into Advantage+ sales campaigns at all."*
- *"Migrating or migrating and copying an ASC/AAC campaign into Advantage+ format ... **will force the campaign into the learning stage**. ... This applies to all campaigns and there is not a workaround for the learnings."*

### 2.5 `existing_customer_budget_percentage` is being killed

> "The `existing_customer_budget_percentage` field is not available for new Advantage+ campaigns. Existing ASC campaigns with this field will remain functional until v26.0, **when they will be paused**."

Meta's documented replacement is a manual two-ad-set pattern you must implement yourself:
- Ad set A: include the existing-customer custom audience, with `"targeting_relaxation_types": {"custom_audience": 0}` so it is **not** relaxed, and cap it with `daily_min_spend_target` / `daily_spend_cap`.
- Ad set B: same creative, with `excluded_custom_audiences` set to the same audience.

```json
{"targeting":{"geo_locations":{"countries":["US"]},
 "custom_audiences":[{"id":"<CUSTOM_AUDIENCE_ID>"}],
 "targeting_relaxation_types":{"custom_audience":0}}}
```

**Build note:** new-vs-existing customer budget split is now *your* job. This is a small but real gap Meta re-opened.

### 2.6 What the old ASC endpoint used to give you (for reference / legacy accounts)

Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-shopping-campaigns>

- *"Only **one** Ad Set can be associated with each ASC campaign"* — removed in the new model: *"may now create more than one adset per campaign."*
- *"test up to **150** different combinations"* of creative (vs 50 in the manual world).
- `billing_event=IMPRESSIONS` was the only supported billing event.
- `roas_average_floor` valid range `[100, 10000000]` = min ROAS `[0.01, 1000.0]`.
- `geo_locations.regions` limit: **200**.
- Account controls (`POST /act_<ID>/account_controls`): minimum age settable **18–25 only**, no maximum age; geo exclusions by country/state/city/DMA/zip; placement exclusions.

---

## 3. Advantage+ audience, placements, budget — exact API semantics

### 3.1 Advantage+ audience
Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/targeting-expansion/advantage-audience>

> "Non-negotiable business constraints are NOT expanded, these include location constraints, minimum age, language, and custom audience exclusions."

**The v23.0 breaking change most people miss:**
> "Beginning with v23.0, the `advantage_audience` parameter within `targeting_automation` defaults to `1` **or requires an explicit value** of either `1` or `0`. This behavior applies only when creating a new ad set; updating an existing ad set will not exhibit this behavior on any version."

Age semantics when Advantage+ audience is ON:
- You may pass `age_range: [min, max]`.
- Omitting `age_range` → derived from `age_min`/`age_max`.
- **`age_min` may only be 18–25.** `age_max` **cannot be set** and is fixed at 65.
- The delivery system resets `age_min`/`age_max` to defaults.

The API **errors** if your targeting is neither "default" nor "relaxed" and you did not explicitly set `advantage_audience`. Example that errors: `age_min: 30, age_max: 50` + a `custom_audiences` inclusion with no relaxation and no explicit flag.

Relaxed setup shape:
```json
{"targeting":{"age_max":65,"age_min":18,
 "custom_audiences":[{"id":"<CA>"},{"id":"<LAL>"}],
 "flexible_spec":[{"interests":[{"id":"<INTEREST_ID>"}]}],
 "geo_locations":{"countries":["US"],"location_types":["home","recent"]},
 "targeting_relaxation_types":{"custom_audience":1,"lookalike":1},
 "targeting_optimization":"expansion_all"}}
```

### 3.2 The three targeting-automation properties (they are NOT the same thing)
Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/advantage-targeting>

| Property | Where | Mutability | Meaning |
|---|---|---|---|
| `targeting_optimization_types` | campaign spec | **view only** | enforced automation (`{detailed_targeting: 1, lookalike: 1}`) |
| `targeting_relaxation_types` | targeting spec | editable | opt-in lookalike + custom-audience expansion |
| `targeting_optimization` | targeting spec | editable | detailed-targeting expansion (e.g. `"expansion_all"`) |

Meta **force-sets** `lookalike` and `detailed_targeting` to `1` for a long list of optimization goals including: Value, App installs, App events, Offsite clicks, Landing page views, Offsite conversions, Return on ad spend, Onsite conversions, App installs and offsite conversions, Incremental offsite conversions, Store visits, Subscribers, Clicks, Offer claims. **For a conversion campaign, "narrow targeting" is not something you can buy back.** Also: *"Automation is not supported in Reservation flows."*

### 3.3 Advantage campaign budget (CBO)
Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/bidding/guides/advantage-campaign-budget>

Campaign-level: `daily_budget`, `lifetime_budget`, `pacing_type` (`standard` | `no_pacing` | `day_parting`), `bid_strategy`, `adset_bid_amounts`, `adset_budgets` (setting this **disables** CBO). Do **not** use `budget_rebalance_flag`.

Ad-set-level controls under CBO: `daily_min_spend_target`, `daily_spend_cap`, `lifetime_min_spend_target`, `lifetime_spend_cap`, `bid_amount`, `bid_constraints` (`roas_average_floor`).

Hard limits, verbatim:
- *"For `LOWEST_COST_WITH_MIN_ROAS`, you cannot currently switch to other bid strategies after you create your campaign."*
- *"All optimization goals must be the same across ad sets under auto bid. Once you run ads in a campaign, you cannot edit optimization goals."*
- *"If your campaign has more than **70 ad sets** and uses an Advantage campaign budget, you are not able to edit your current bid strategy or turn off your Advantage campaign budget."*
- `pacing_type` must be set at campaign level, not ad set level.

**Build note:** the "cannot edit optimization goal after delivery" rule means your agent's only lever to change goal is *create a new ad set*. Design your state machine around create-and-swap, not mutate.

---

## 4. Advantage+ creative — the complete API surface

Primary source: **<https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/advantage-creative/get-started>**

### 4.1 Shape

Everything lives under `degrees_of_freedom_spec.creative_features_spec.<feature>.enroll_status ∈ {OPT_IN, OPT_OUT}`. Reference: <https://developers.facebook.com/docs/marketing-api/reference/ad-creative-degrees-of-freedom-spec/> → `creative_features_spec` (type `AdCreativeFeaturesSpec`).

```bash
curl -X POST \
  -F 'name=Advantage+ Creative Creative' \
  -F 'degrees_of_freedom_spec={
    "creative_features_spec": {
      "image_touchups":  {"enroll_status": "OPT_IN"},
      "inline_comment":  {"enroll_status": "OPT_IN"},
      "image_templates": {"enroll_status": "OPT_IN"}
    }
  }' \
  -F 'access_token=<ACCESS_TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/adcreatives
```

Works identically inline inside the `creative` object on `POST /act_<ID>/ads`.

### 4.2 Documented features (from the Get Started guide)

| API name | Ads Manager label | AI-generated? | Notes |
|---|---|---|---|
| `adapt_to_placement` | Image touch-ups | no | **Default OPT_IN — and the ONLY feature that is.** Verbatim: *"Default is opt-in. Opt-in if you want to automatically fit images to placements based on what is predicted to work best."* 4:5 and 9:16 enabled by default. Tunable via `customizations.aspect_ratio_config` / `image_crop_style`. |
| `add_text_overlay` | Add dynamic overlays | no | Catalog item info as overlays. Manual control via `ad-creative-link-data-image-layer-spec`. |
| `creative_stickers` | Create sticker CTA | **yes** | "AI-generated stickers ... We'll automatically place CTA stickers based on where they're likely to perform best." |
| `description_automation` | Dynamic description | no | ~~Default OPT_IN.~~ **Correction (fact-check 2026-09-02): NOT default opt-in.** The Get Started guide describes it as optional: *"Opt-in if you want item information from your catalog to be used for your ad's description based on what each person who views your ad is likely to engage with."* Only `adapt_to_placement` is documented as default opt-in. |
| `enhance_cta` | Enhance CTA | no | `customizations: {"text_extraction": {"enroll_status": "OPT_IN"}}` to use "potential high-performing phrases identified by AI". |
| `image_animation` | (unlabelled) | **yes** | "a static image in your ad to be automatically transformed into a short animated video that adds subtle motion". **This is Meta's closest thing to AI video generation in ads.** |
| `image_background_gen` | Generate backgrounds | **yes** | Catalog/DPA + Mobile Feed only (see §5). |
| `image_brightness_and_contrast` | Adjust brightness and contrast | no | |
| `image_templates` | Add overlays | **yes** | Video-ineligible. |
| `image_text_translation` | Translate image text | no (translation) | Mobile Feed + Mobile Reels; single image only. |
| `image_touchups` | Visual touch-ups | no | Image ads only. |
| `image_uncrop` | Expand image | **yes** | See §5. |
| `inline_comment` | Relevant comments | no | ~~Default OPT_IN.~~ **Correction (fact-check 2026-09-02): NOT default opt-in.** Verbatim: *"Opt-in if you want the most relevant comment to be displayed below your ad on Facebook and Instagram."* |
| `media_type_automation` | Allow product video | no | Show catalog videos alongside images. |
| `pac_relaxation` | Flex media / Flexible media | no | Show a given aspect ratio across all placements. |
| `product_extensions` | (Collection dropdown) | no | Catalog items shown next to your media. |
| `reveal_details_over_time` | Reveal details over time | no | Pulls info from your website / app-store page on dwell. |
| `text_optimizations` | Text improvements | no | Mix/match your supplied primary text, headline, description. `customizations.text_extraction` opts into AI-identified phrases. |
| `text_translation` | Translate text | no | |
| `translate_voiceover` | Translate voiceover | **yes** | **English → Spanish only.** FB/IG Feed + Reels. Single video. |
| `video_auto_crop` | Visual touch-ups | no | Video ads only. |
| `video_filtering` | (unlabelled) | no | Colour improvement, SDR→HDR. |
| `video_uncrop` | (unlabelled) | **yes** | "automatically expanded to fit more placements, filling the available space instead of cropping or letterboxing". |

### 4.3 Features present in the node reference but NOT in the Get Started guide

> **[FACT-CHECK ADDITION 2026-09-02] The divergence runs BOTH ways, and the original draft only recorded one direction.**
>
> **Seven of the 23 features documented in the Get Started guide do not appear in the `AdCreativeFeaturesSpec` node reference at all:** `enhance_cta`, `image_brightness_and_contrast`, `image_text_translation`, **`image_uncrop`**, `video_auto_crop`, **`video_filtering`**, **`video_uncrop`**. Verified twice against <https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/> on 2026-09-02.
>
> Two of those absentees — `image_uncrop` and `video_uncrop` — are AI-generated features, and `image_uncrop` is one of only three features with its own dedicated generative-AI guide (§5.2). **So the node reference is not a complete or authoritative inventory of `creative_features_spec`.** Do not generate your feature enum from it, and do not treat "absent from the reference" as "does not exist". Treat the union of the Get Started table (23) and the reference list (~30 further names) as the candidate space, and confirm each by writing it and reading the effective spec back (§4.5).
>
> **The exact field count on the reference page could not be pinned down** — repeated extractions returned 45, 46 and 51. The "46" below is the original researcher's count and is **UNVERIFIED**; treat it as approximate.

The `AdCreativeFeaturesSpec` reference (<https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/>) lists **~46 (unverified count)** fields. Beyond the table above, these exist with **no documented description** (the reference literally echoes the field name as its description):

`ads_with_benefits`, **`biz_ai`**, `customize_product_recommendation`, `fb_feed_tag`, `fb_reels_tag`, `fb_story_tag`, `generate_cta`, `hide_price`, `ig_feed_tag`, `ig_reels_tag`, `ig_stream_tag`, `local_store_extension`, `media_order`, `multi_photo_to_video`, **`music_generation`**, `profile_card`, `profile_extension`, `replace_media_text`, `show_destination_blurbs`, `show_summary`, `site_extensions`, `standard_enhancements`, `standard_enhancements_catalog`, `text_extraction_for_headline`, `text_extraction_for_tap_target`, `text_overlay_translation`, `video_highlights`, `video_to_image`, `wa_mm_image_filtering`, `wa_mm_text_truncation_length`.

Notable inferences (**INFERRED, not documented**): `show_summary` is the "comment summaries" feature; `multi_photo_to_video` and `video_to_image` are cross-modal creative transforms (the latter is corroborated by Meta's Muse Image post: *"producing static images directly from video creative"*); `music_generation` is distinct from the `music` feature (which is `asset_feed_spec`-based); `biz_ai` is presumably the Business-AI creative hook.

**Gotcha:** opting into an undocumented feature is unsupported and unpreviewable. Treat this list as a roadmap indicator, not an API contract.

### 4.4 Music is NOT in `creative_features_spec`

Verbatim: *"Most Advantage+ creative features can be opted into using the `creative_features_spec` parameter with the exception of the `music` feature which is implemented with the `asset_feed_spec` parameter."*

```bash
-F 'asset_feed_spec={"audios": [{"type": "random"}]}'
```
To opt **out**, pass `asset_feed_spec.audios` as empty. Use of music is subject to the Sound Collection Terms (<https://facebook.com/sound/collection/terms>).

### 4.5 Silent removal of ineligible features

> "Features specified as `OPT_IN` but ineligible for the given ad setup will be automatically removed from the `creative_features_spec` parameter. For example, `image_templates` (or **Add overlays**) is not eligible to be applied to video format creatives — if you opt-in to this feature on a video ad, it will be automatically removed as ineligible."

> "Don't worry if you see `standard_enhancements` or any standard enhancements sub-features appended to `creative_features_spec` when you retrieve it. As long as they are not set to `OPT_IN`, they will not be applied."

**Build note:** always `GET` `creative_features_spec` back after write and diff it against what you sent. Store the *effective* spec, not the requested one, or your attribution of performance to features will be wrong.

### 4.6 The mandatory pause-preview-activate loop for AI features

This is the single most important operational constraint on full autonomy:

> "**Note:** If the opted-in features include features generated with AI, you must create the ad with a `PAUSED` status, then follow Step 2 and Step 3 below to complete the publishing process. If no AI-generated features are included, Step 2 and Step 3 are optional, and you can create the ad with an `ACTIVE` status."

> "When creating an ad through the `/ads` endpoint, the `status` field on the ad is set to `PAUSED` by default."

Preview call:
```bash
curl -X GET -G \
  -d 'ad_format=DESKTOP_FEED_STANDARD' \
  -d 'creative_feature=<FEATURE_NAME>' \
  -d 'access_token=<ACCESS_TOKEN>' \
  https://graph.facebook.com/v26.0/<AD_ID>/previews
```
Response carries `transformation_spec.<FEATURE_NAME>[].status ∈ {"eligible","pending","ineligible"}` plus an iframe body.

> "**Note:** If a `transformation_spec` object is not returned, the creative is not eligible for the Advantage+ creative feature on the chosen placement, and the feature will not be applied."

Previewable features: `image_templates`, `image_touchups`, `video_auto_crop`, `enhance_cta`, `text_optimizations`, `image_background_gen`, `image_uncrop`, `description_automation`, `translate_voiceover`, `image_animation`, `video_filtering`, `video_uncrop`.

Then `POST /<AD_ID>` with `status=ACTIVE`.

**Design consequence:** an autonomous system must implement its own *automated* preview gate — fetch the preview iframe, render it, and run a VLM check for brand/product fidelity and text legibility before flipping to ACTIVE. That check is a genuine product surface a third party can own; Meta gives you the preview but not the judgement.

### 4.7 Standard enhancements: deprecated

Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads/standard-enhancements>

> "Starting with Marketing API v22.0, opting in or out of standard enhancements will no longer be available."

The bundle was: single image → `image_template`, `image_touchups`, `text_optimizations`, `inline_comment`; single video → `video_auto_crop`, `text_optimizations`, `inline_comment`. **Do not use the `standard_enhancements` key in new code.**

### 4.8 Format automation (`format_transformation_spec`)

Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/format-automation>

A *separate* top-level creative parameter (not inside `degrees_of_freedom_spec`). Each entry is `{format, data_source[]}`.

Formats observed: `da_collection`, `sa_collection`, `carousel`, `single_media`, `video_slideshow`.
Data sources: `catalog`, `manual_uploads`, `site_links`, `app_information`, `none`.

- Opt out of one transformation: `{"format":"sa_collection","data_source":["none"]}`
- Opt into all sources for a transformation: `{"format":"carousel","data_source":[]}`
- Omit the whole parameter → default behaviour.

Paired with `asset_feed_spec.optimization_type: "FORMAT_AUTOMATION"` and `ad_formats: ["CAROUSEL","COLLECTION"]` for catalog cases.

**`video_slideshow` from `site_links` or `app_information` is Meta generating a video for you from scraped web/app-store media.** It is the only "make me a video from nothing" path Meta ships in the API, and it is a slideshow, not generative video.

### 4.9 Advantage+ creative for catalog

Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-creative-for-catalog>

Requires `product_set_id`, `object_story_spec.template_data` (with `multi_share_end_card`, `name`, `link`, `message`, `call_to_action`), and `asset_feed_spec` with `optimization_type: FORMAT_AUTOMATION` + `ad_formats: ["CAROUSEL","COLLECTION"]`. Meta picks format, whether to show a description, and which description, **per impression**.

---

## 5. Meta's generative AI ad tools — exactly what is exposed via API

Primary source: **<https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/generative-ai-features>**

Only **three** generative features are documented as first-class API features:

### 5.1 `text_generation` (Ads Manager: "Text variations")

Requires a `message` in `object_story_spec.link_data`. Meta then **rewrites your creative object**: it injects an `asset_feed_spec` with generated `bodies` and `optimization_type: "DEGREES_OF_FREEDOM"`.

```json
{"asset_feed_spec": {
  "bodies": [
    {"text": "Buy some cool LED TV at cheap price"},
    {"text": "Get your dream LED TV at an unbeatable price! Buy now and save big!"},
    {"text": "Get the best LED TV deals! 📺 Save money and upgrade your entertainment."},
    {"text": "Get an LED TV at a low cost! Cheap, high-quality options are available."},
    {"text": "Get LED TVs at affordable prices  ✨  !"}
  ],
  "optimization_type": "DEGREES_OF_FREEDOM"},
 "id": "<CREATIVE_ID>"}
```

Read it back with `GET /<CREATIVE_ID>?fields=asset_feed_spec` or `GET /<AD_ID>?fields=creative{asset_feed_spec,status}`.

**Two hard operational facts:**
1. *"Opt-in to the feature only applies to the ad or creative created in the current request."* — it is per-object, not a setting.
2. **There is no regenerate and no reject-one.** *"If any of the generated suggestions are not acceptable, create a new ad or creative without opt-in to Text Generation."* You cannot delete variant #4; you throw the whole creative away.

Look at that sample output. Five near-identical price-led restatements of one sentence. **That is the quality bar you are competing with on copy**, and it is low — Meta's text generation is a paraphraser seeded by your own line, not a strategist. This is a genuine, quantifiable third-party opening.

### 5.2 `image_uncrop` (Ads Manager: "Image expansion")

Supported placements, verbatim: `INSTAGRAM_STANDARD`, `FACEBOOK_REELS_MOBILE`, `INSTAGRAM_REELS`, `MOBILE_FEED_STANDARD`, `INSTAGRAM_STORY`.

Preview without creating an ad: `GET /act_<AD_ACCOUNT_ID>/generatepreviews?ad_format=...&creative_feature=image_uncrop&creative={...}`.

### 5.3 `image_background_gen` (Ads Manager: "Generate backgrounds")

> "**Warning:** Background generation currently only works with dynamic product ads or Advantage+ catalog ads on Mobile Feed."

Requires `product_set_id`. Preview only on `MOBILE_FEED_STANDARD`. Live preview may return `status: "PENDING"` with a stock placeholder if the catalog render isn't ready.

**This is a much narrower feature than the marketing implies.** If your advertiser has no catalog, Meta's background generation is unavailable to them through the API.

### 5.4 Legal / transparency framing

> "Meta does not make any warranties regarding the completeness, reliability, and accuracy of the suggested text generations, generated backgrounds, or expanded images."

> "Advertisers are responsible for previewing ad creative featuring AI-generated creatives before publishing their ads."

Governing terms: **Ad Creative Generative AI Terms** <https://www.facebook.com/legal/terms/ad_creative_generative_ai_terms> *in addition to* Meta Platform Terms.

AI labelling: *"Ad images created or materially edited with certain Meta generative AI creative features ... may include AI info within the three-dot menu of an ad or have an AI info label next to the Sponsored label."* (<https://www.facebook.com/business/help/539137881899016>, and <https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/>.)

Separately, `AdCreative.authorization_category` now includes the enum **`POLITICAL_WITH_DIGITALLY_CREATED_MEDIA`** (<https://developers.facebook.com/docs/marketing-api/reference/ad-creative/>) — relevant only if you ever touch issue/political ads, but it shows Meta's disclosure machinery is field-level.

### 5.5 The state of Meta's AI **video** generation for ads — the honest answer

**Shipped in the ads product (verified in API docs):**
- `image_animation` — static image → short animated video, marked "generated with AI".
- `video_uncrop` — AI outpainting of video to new aspect ratios.
- `video_filtering` — colour / SDR→HDR enhancement.
- `translate_voiceover` — AI dubbing, **English→Spanish only**, first 6 s previewable, full render happens asynchronously *after publish*, and *"The translated voiceover cannot be edited or regenerated."*
- `video_slideshow` via `format_transformation_spec` — assembles a video from site-link or app-store media.
- Undocumented/limited: `multi_photo_to_video`, `video_highlights`, `video_to_image`.

**NOT shipped for ads:** text-to-video or image-to-video generative ad creative. The generative-AI features doc covers only text, image expansion, and background generation. There is no `video_generation` field in `AdCreativeFeaturesSpec`.

**Meta's own frontier video model is still a preview.** <https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/> (2026-07-05):
> "Muse Image is available today across the Meta AI app and on meta.ai, Instagram Stories in the US, and WhatsApp in limited countries, and is coming soon to Facebook. **Muse Video is coming soon to creators and Meta AI.**"
> "On Arena, Muse Video ranks **No. 3** in human-preference Elo for text-to-video at the time of writing."

**Muse Image *is* coming to ads.** <https://www.facebook.com/business/news/muse-image-for-businesses> (2026-07-07):
> "In the coming weeks, Muse Image, the first image generation model from Meta Superintelligence Labs, will help power image generation in Meta Advantage+ creative"
> "More than **8 million advertisers** are using at least one of our generative AI ad creative tools."
> Current image-gen capabilities in Advantage+ creative: "generating new backgrounds around product images, ... creating full lifestyle image variations inspired by existing ads, ... producing static images directly from video creative."
> Advertiser quotes flag the *prior* weakness explicitly: *"You'd be surprised how hard it is for AI to make our products look like ours—the compact shape, the cap finish, the size of our logo. Previous generations got those details slightly wrong every time."*

**The one contradicting datapoint.** <https://about.fb.com/news/2026/01/2026-ai-drives-performance/>:
> "AI is also powering stronger ad creative. In Q4 2025, **the combined revenue run-rate of our video generation tools hit $10 billion**, with quarter-over-quarter growth nearly three times faster than overall ads revenue."

I cannot reconcile this with the API surface. Meta's phrasing ("revenue run-rate of our video generation tools") is the same construction it uses for Advantage+ Shopping revenue run-rate — i.e. **ad spend flowing through campaigns that use the tools**, not revenue Meta charges for the tools. It most plausibly counts spend on ads touched by `image_animation`, `video_uncrop`, `video_filtering`, `video_slideshow` and the Ads-Manager-only video features. **Marked UNVERIFIED**: whether Meta ships an Ads-Manager-only text/image-to-video generator not exposed via Marketing API. Trade coverage suggests something exists (Social Media Today, 2025-10-29, "Meta Unveils New AI Ad Tools, Including Improved Video Generation Options"; SiliconANGLE, 2025-06-23, "Meta debuts new generative AI tools for creating video-based ads"), but I could not retrieve a primary Meta source for it in this session.

**Build conclusion (high confidence):** if your platform generates real video ads — multi-shot, scripted, brand-controlled, hook-tested — you are not duplicating Meta. Meta animates and reframes assets you already have; it does not originate video ads. And even if an Ads-Manager-only video generator exists, **it is not in the Marketing API**, so a programmatic pipeline cannot call it. That gap is your product.

### 5.6 AI Sandbox — status

"AI Sandbox" was Meta's May-2023 closed-alpha testbed. Per <https://www.facebook.com/business/news/generative-ai-features-for-ads-coming-to-all-advertisers> (2023-10-04): *"Earlier this year, we announced the AI Sandbox where we've been testing these generative AI features with a small and diverse set of advertisers."* Those three features (Background Generation, Image Expansion, Text Variations) went GA and are now the `image_background_gen` / `image_uncrop` / `text_generation` API fields. **AI Sandbox as a distinct advertiser-facing program appears defunct**; I found no Meta reference to it after 2023. Marked **UNVERIFIED** as to formal shutdown.

---

## 6. Meta's own optimisation loop: Opportunity Score + Recommendations API + webhooks

**This is the section most third-party "AI ad optimiser" pitches quietly ignore, and it is the most direct competitive threat.**

Primary source: **<https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/performance-recommendations>**

### 6.1 Opportunity score

- Exposed as a **field on the AdAccount node** (<https://developers.facebook.com/docs/marketing-api/reference/ad-account/>): `opportunity_score` — *"On a 0-100 point scale, this score represents how optimized the ad account's campaigns, ad sets and ads are overall."* There is also `opportunity_score_weight`.
- Updated in near-real-time as campaigns change.
- Announced GA globally 2025-06-09: <https://www.facebook.com/business/news/elevate-your-campaign-performance-with-opportunity-score>. Claimed effect: *"Small business advertisers who adopted opportunity score recommendations saw a **12% median decrease in their cost per result**."*
- Same post confirms the Advantage+ unification and its measured effect: *"advertisers that start their sales and app campaigns fully enabled with AI-driven optimizations saw a **7% to 9% CPA improvement**, on average."* and *"advertisers no longer need to choose between running a manual or Advantage+ sales or app campaign."*
- Explicitly supersedes Meta's older static playbooks: *"evolving beyond earlier static frameworks like the Performance 5 or Power 5."*

### 6.2 Reading recommendations

```bash
GET https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/recommendations
GET https://graph.facebook.com/v26.0/<BUSINESS_ID>/recommendations   # portfolio-wide
```

Business-level query params: `ad_account_ids` (max **100**, disables pagination), `recommendation_stages` (`mid_flight_recommendation`, `pre_create_guidance`; `pre_flight_recommendation` also exists), `recommendation_names` (snake_case, e.g. `fragmentation`, `aplusc_standard_enhancements_bundle`), `locale`, `fields` (**pass `recommendation_content` explicitly — `lift_estimate` and `body` are omitted by default**), `limit` (default 25, max 100), `after`/`before`.

Response fields per recommendation: `recommendation_signature`, `recommendation_stage`, `recommendation_time` (ISO 8601), `recommendation_name`, `type`, `level` (`ad`|`ad_set`|`campaign`|`ad_account`), `object_ids[]`, `opportunity_score_lift` (points), `url` (Ads Manager deep link), `recommendation_content.{lift_estimate, body}`.

Business-level responses additionally carry `ad_account_id` and `opportunity_score` per account.

> **[FACT-CHECK ADDITION 2026-09-02] The field list above is incomplete, and the missing fields are the operationally important ones.** The `ad_recommendations` webhook doc (<https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/ad-recommendations>) prescribes this follow-up query, which names six fields the original draft never recorded — including a **server-side priority score** and a **structured suggested-value payload**:
>
> ```
> GET /act_<AD_ACCOUNT_ID>/recommendations
>   ?fields=recommendation_type,title,message,importance,estimated_impact,blame_field,object_id,recommendation_data
>   &filtering=[{"field":"object_id","operator":"EQUAL","value":"<OBJECT_ID>"}]
> ```
>
> Verbatim from that doc: *"`importance` supports prioritization or auto-apply rules, `estimated_impact` projects the lift if you apply the change, `blame_field` names the setting to change, and `recommendation_data` holds the structured suggested values."*
>
> **Build note:** `importance` + `estimated_impact` + `blame_field` + `recommendation_data` is a ready-made auto-apply policy surface — Meta is telling you which setting to change, what to change it to, how much it is worth, and how urgent it is. Also note `/recommendations` supports server-side `filtering=[...]` with `field`/`operator`/`value`, so you do not have to page the whole account to find recommendations for one object.

> "Recommendations are refreshed periodically. A `recommendation_signature` may become invalid if the recommendation is no longer applicable." / "Stale or old recommendations cannot be applied and will fail during apply."

### 6.3 Applying recommendations programmatically

```bash
POST https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/recommendations
  -d 'recommendation_signature=1234567'
  -d 'extra_data={"object_selection": "7656787679008"}'
```
Returns `{"success": true}`.

Per-type `extra_data` contracts (all documented):

| Type | `extra_data` |
|---|---|
| `ADVANTAGE_PLUS_AUDIENCE` | `{}` |
| `AUTOMATIC_PLACEMENTS` | `{}` |
| `CONVERSION_LEADS_OPTIMIZATION` | `{}` (duplicates ad sets/ads with an optimised goal) |
| `LANDING_PAGE_VIEW_OPTIMIZATION_GOAL` | `{}` |
| `PRODUCT_SET_BOOSTING` | `{}` |
| `APLUSC_STANDARD_ENHANCEMENTS_BUNDLE` | `object_selection`, `creative_feature_opt_in_overrides` (JSON array of `{ad_id, opted_in_creative_feature_names[]}`; allowed names `image_templates, image_touchups, text_optimizations, video_auto_crop, video_uncrop, standard_enhancements` — **"standard_enhancements must be included alongside any other feature"**) |
| `AUTOFLOW_OPT_IN` | `object_selection` |
| `BACKGROUND_GENERATION` | `action_type` (**required**, `OPT_IN`/`OPT_OUT`), `object_selection` (**required**) |
| `CREATIVE_FATIGUE` | `object_selection` — *"it uses generative AI to create new creative variations for your ads"* |
| `MUSIC` | `object_selection` |
| `PERFORMANT_CREATIVE_REELS_OPT_IN` | `object_selection` (ad set IDs; skips ad sets already on automatic placements) |
| `SCALE_GOOD_CAMPAIGN` | `adsets` / `campaigns`: JSON arrays of `{ad_object_id, additional_budget}` **in cents** (`6000` = $60) |
| `SHOPS_ADS_SAOFF` | `object_selection` |
| `UNCROP_IMAGE` | `object_selection` |

Deprecated legacy shape (`music_parameters` / `autoflow_parameters` / `fragmentation_parameters` as top-level objects) still documented — **do not use**.

### 6.4 The full recommendation-type catalogue (what Meta already diagnoses for free)

`ADVANTAGE_PLUS_AUDIENCE`, `ADVANTAGE_PLUS_CATALOG_ADS`, `APLUSC_ADD_OVERLAYS`, `APLUSC_STANDARD_ENHANCEMENTS_BUNDLE`, `APLUSC_TEXT_IMPROVEMENTS`, `APLUSC_VISUAL_TOUCHUPS`, `AUTOFLOW_OPT_IN`, `AUTOMATIC_PLACEMENTS`, `BACKGROUND_GENERATION`, `BUDGET_LIMITED`, `CAPI_CRM_GUIDANCE_V2`, `CAPI_CRM_SETUP`, `CAPI_PERFORMANCE_MATCH_KEY_V2`, `CONVERSION_LEADS_OPTIMIZATION`, `CREATIVE_FATIGUE`, `CREATIVE_LIMITED`, `CTX_CREATION_PACKAGE`, `FRAGMENTATION_V3`, **`GEN_AI_MVP`**, `LANDING_PAGE_VIEW_OPTIMIZATION_GOAL`, `MESSAGING_EVENTS`, `MESSAGING_PARTNERS`, `MULTI_TEXT`, `MUSIC`, `OFFSITE_CONVERSION`, `PARTNERSHIP_ADS`, `PERFORMANT_CREATIVE_REELS_OPT_IN`, `PIXEL_OPTIMIZATION_HIE`, `PIXEL_UPSELL`, `PRODUCT_SET_BOOSTING`, `SCALE_GOOD_CAMPAIGN`, `SHOPS_ADS_SAOFF`, `SIGNALS_GROWTH_CAPI_V2`, `UNCROP_IMAGE`, `UNIFIED_INBOX`, `VALUE_OPTIMIZATION_GOAL`, `WA_MESSAGING_PARTNERS`.

`GEN_AI_MVP` is described as: *"suggests AI-generated creative variations to help advertisers improve ad performance ... during ad creation and editing (PFR) and can also recommend updates after the ad is live and running (MFR)."*

`FRAGMENTATION_V3`: *"Recommends consolidating ad sets to improve liquidity when 2 or more have similar variables"* — i.e. Meta actively fights the "many-ad-sets" strategy most legacy media buyers (and most naive automation) implement.

**Caveat Meta itself states:** *"Meta is frequently testing new types of recommendations on the Ads Manager Web UI. Under certain circumstances, there could be fewer recommendations returned by the API versus what is shown in Ads Manager."*

### 6.4b Performance Recommendations History API — **MISSED IN THE ORIGINAL DRAFT**

> **[FACT-CHECK ADDITION 2026-09-02]** Meta ships a *second*, separately-documented recommendations endpoint that the original research did not find: the **Performance Recommendations History API**.
>
> Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/performance-recommendations-history-api>
>
> ```
> GET /act_<AD_ACCOUNT_ID>/opportunity_score_history
> ```
>
> Verbatim: *"This ad-account-level endpoint returns the daily history of an ad account's Opportunity Score over a configurable time range, with optional explainability that surfaces the campaign-level changes driving each score movement."*
>
> - Fields: `date` (YYYY-MM-DD), `opportunity_score` (0–100), and — when `get_reason=true` — a `changelog` containing `campaign_id`, `score_change`, `ad_object_id`, `ad_object_type`, `budget_then`, `budget_now`, `eligible_recommendation_types_then`/`_now`, `applied_recommendation_types_then`/`_now`.
> - `from_date` defaults to 14 days before `to_date` and **cannot be earlier than 45 days** before it; `to_date` defaults to today. **Maximum window 45 days.** *"Due to the data latency, data may be missing the most recent two days."*
>
> **Why this matters more than the point-in-time score:** `opportunity_score` alone is a scalar with no history. This endpoint gives you a **time series with per-campaign attribution of every score movement, plus which recommendation types were eligible and which were applied, before and after**. That is a free, first-party, causally-annotated audit log of account configuration changes — exactly the substrate you would otherwise have to build from Activity Logs. Poll it daily, retain it (the 45-day window means Meta will not remember it for you), and use `applied_recommendation_types_*` to measure whether applying Meta's own recommendations actually helped this account.
>
> Also resolves open question #13: `opportunity_score_weight` is **not** vaguely "budget-based weighting". Verbatim from the AdAccount reference: *"This opportunity score weight represent the remaining budget for the ad account in cents, computed daily. This can be used with other ad accounts within the same business to compute the weighted opportunity score for a business."*

### 6.5 Webhooks — push, not poll

Source: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/ad-recommendations> and `.../creative-fatigue` (both *Updated: Jul 6, 2026*).

`ad_recommendations` payload (`object: "ad_account"`):
```json
{"field":"ad_recommendations","value":{
 "ad_account_id":"<ID>","ad_object_ids":["<OBJECT_ID>"],
 "recommendation_type":"AUTOFLOW_OPT_IN","recommendation_signature":"",
 "recommendation_message":"Your ad recommendation is ready.",
 "recommendation_stage":"mid_flight_recommendation",
 "recommendation_hash":"abcdef1234567890"}}
```

`creative_fatigue` payload:
```json
{"field":"creative_fatigue","value":{
 "ad_account_id":"<ID>","adgroup_id":"<AD_ID>",
 "creative_fatigue_level":"HIGH",
 "creative_fatigue_message":"Your ad fatigue changed from medium to high. ..."}}
```
`creative_fatigue_level ∈ {LOW, MEDIUM, HIGH}`.

Meta's own doc even prescribes the diagnostic follow-up:
```
GET /<AD_ID>/insights?fields=impressions,frequency,ctr,cpc,actions,cost_per_action_type,date_start,date_stop&date_preset=last_7d&time_increment=1
GET /<AD_ID>?fields=creative{id,name,image_hash,image_url,body,title},adset{id,name,targeting,daily_budget},status
```
and the two remediation patterns (swap `creative_id` on the live ad, or pause + create a replacement ad).

Other ads webhooks available: `effective_status`, `in-process ad objects`, `with-issues ad objects`.

**Strategic read:** Meta has shipped, for free, a complete event-driven optimisation loop — *fatigue detection → typed recommendation → one-call apply*. Any third-party product whose core is "we watch your account and tell you what to change" is now selling a wrapper over `/recommendations`. **Your platform should consume these webhooks as an input signal, not reimplement them, and must differentiate above this line.**

---

## 7. Meta's agentic layer: ads MCP server, ads CLI, MCP rules

Announced: **<https://www.facebook.com/business/news/meta-ads-ai-connectors>** — dated **2026-04-29**, with an update banner dated **2026-07-16**.

> "**Update: On July 16, 2026**, we introduced two new capabilities to Meta's ads MCP server. You can now **connect any AI application directly to Meta ads using your own developer app**, enabling deeper, more customizable integrations. We're also launching **ads MCP server rules**, giving anyone with full control of a business portfolio the ability to govern what AI agents can do on their ad account, from budget changes to catalog updates."

The family is called **Meta ads AI connectors** and comprises the **ads MCP server** and an **ads CLI**.

### 7.1 The MCP server

Docs: <https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview>

- Remote-hosted at **`https://mcp.facebook.com/ads`**, streamable HTTP, works with any MCP client.
- Auth: OAuth via Facebook Login for Business, **or** a user access token in `Authorization: Bearer <TOKEN>`.
- Required permissions: **`ads_mcp_management`**, `ads_read`, `ads_management`, `catalog_management`, `business_management`, `pages_show_list`, `instagram_basic`.
- App setup: add the **"Create & manage ads with ads MCP server"** use case to a Meta developer app. *"Owning a Meta app is not a prerequisite"* — non-developers set it up via <https://www.facebook.com/business/help/1456422242197840>.
- Claude Code one-liner from Meta's own docs:
  ```bash
  claude mcp add --transport http --client-id <META_APP_ID> meta-ads https://mcp.facebook.com/ads
  ```
- Raw JSON-RPC works too:
  ```bash
  curl -i -X POST "https://mcp.facebook.com/ads" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    --data-raw '{"jsonrpc":"2.0","method":"tools/list","id":1}'
  ```

Seven tool categories: comprehensive reporting; ad creation and management; catalog creation and management; signals and datasets; help and troubleshooting (Business Help Center search); A/B tests and conversion lift studies; activity logs.

**Write tools that exist today** (<https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-tools-ad-creation-and-management>): `ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad`, `ads_create_creative` (single-image link only), `ads_update_entity`, **`ads_activate_entity`**, `ads_boost_ig_post`, `ads_create_custom_audience`, `ads_update_custom_audience`, `ads_update_custom_audience_users` (hashed PII upload), `ads_delete_custom_audience`.

Read tools include `ads_get_ad_accounts`, `ads_get_ad_entities` (primary reporting tool), `ads_get_field_context` (metadata: type, filterability, enum values, supported entity levels — useful for schema discovery), `ads_get_ad_preview`, **`ads_library_search`** (public Meta Ad Library for competitor creative research), `ads_get_ig_media`, `ads_get_ad_images`, `ads_get_ad_videos`.

Safety default, verbatim: *"Write tools create entities in a paused state; your AI client asks for confirmation before activation."*

**Notably absent from the MCP creative tools:** any way to set `degrees_of_freedom_spec` / `creative_features_spec`, any video creative creation, any carousel/collection creative. `ads_create_creative` is *"Create a single-image link ad creative."* **The MCP server is a thin, safe, low-ceiling surface. The Marketing API remains where real automation lives.**

### 7.2 Ads MCP server rules (governance API)

Docs: <https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-rules-best-practices> (*Updated: Aug 12, 2026*)

**Different host and version — this is a trap:**
> "Prepend every path with `https://ads-api.facebook.com/v25.0`." / "Call `ads-api.facebook.com`, **not** `graph.facebook.com`. Use version **v25.0** — v22.0 is deprecated and auto-upgrades."

| Asset | Methods | Path |
|---|---|---|
| Ad account | GET, POST | `/marketing-api/businesses/<BUSINESS_ID>/accounts/act_<AD_ACCOUNT_ID>/ads_mcp_rules` |
| Catalog | GET, POST | `/catalog/businesses/<BUSINESS_ID>/product_catalogs/<CATALOG_ID>/ads_mcp_rules` |

Rule model: `id` (informational — **no per-ID GET/PUT/DELETE**), `action`, `trigger_type`, `status` (`active`|`paused`), `business_id` (server-set), `metadata`.

Ad-account actions × triggers:

| action | trigger_type | metadata | denies |
|---|---|---|---|
| `create_campaign` | `always` | – | creating campaigns |
| `create_ad_set` | `always` | – | creating ad sets |
| `create_ad` | `always` | – | creating ads |
| `edit_budget` | `percentage_change` | `max_percentage` | budget increases above a % |
| `edit_budget` | `absolute_change` | `max_amount_cents` | budget increases above an amount |
| `edit_budget` | `absolute_max` | `max_value_cents` | budgets above a ceiling |
| `edit_targeting` | `always` | – | targeting/audience changes |
| `edit_creative` | `always` | – | creative changes |
| `edit_status` | `always` | – | delivery status changes (pause/activate) |
| `all` | `always` | – | every agent action on the account |

Availability: *"Ads MCP server rules are in **limited availability**. If your business is not enrolled, the ad account endpoint returns **error code 10** and the catalog endpoint returns **HTTP 403**."*

Permissions: ad account GET needs `ads_read`|`ads_management`|`business_management`; POST needs `ads_management`|`business_management`. Catalog GET needs `catalog_management`|`ads_read`|`ads_management`; POST needs `catalog_management`|`ads_management`. **A `business_management`-only token returns HTTP 401 on the catalog endpoint.** System user tokens accepted and recommended for automation.

**Product implication:** enterprise buyers will increasingly ask "what guardrails do you enforce?" Meta has just published the vocabulary (`edit_budget` + `percentage_change` + `max_percentage`, etc.). Adopt that vocabulary in your own guardrail layer; it will be what procurement recognises. Also note these rules only bind agents going through *Meta's* MCP server — they do **not** constrain your own Marketing API calls, which is both an advantage (you're not throttled) and a liability (you must build equivalent controls or you look less safe than Meta's own agent path).

### 7.3 Competitive timeline (secondary source)

<https://ppc.land/innovid-gains-meta-campaign-data-in-nivo-through-ads-mcp-integration/> (2026-09-01) puts Meta's MCP posture in context: Google's Ads API MCP server (2025-10-07) was **read-only**; Microsoft Advertising's MCP reached open pilot 2026-06-17 **query-only**; X shipped 2026-08-24 with 23 tools, 10 writes, every agent-created campaign starting paused. *"Meta went the other way, shipping write capability from the start."*

---

## 8. Business AI / Meta Business Agent / Meta AI business assistant

Three distinct things, frequently conflated:

**1. Meta AI business assistant (in Ads Manager).** <https://about.fb.com/news/2026/01/2026-ai-drives-performance/>:
> "In Q4 last year, we began testing a **Meta AI business assistant** with advertisers to help with things like optimization and account support — and we'll expand it in the coming months so more businesses can chat with an assistant that remembers their goals and offers personalized performance recommendations."

Positioned by Meta as complementary to the MCP connectors: *"use the assistant for guidance in Ads Manager, and your own AI tools for cross-channel insights and custom workflows."* **No public API. UNVERIFIED whether it can take write actions.**

> **[FACT-CHECK ADDITION 2026-09-02] The original draft stopped at January 2026 here and missed Meta's most recent and most directly competitive move.** <https://www.facebook.com/business/news/meta-ai-for-small-businesses> (**2026-08-19**) announces a Meta AI feature set for SMBs that includes:
> - **organic content analysis** (reads your FB/IG engagement to find what resonates),
> - **competitive benchmarking** (analyses comparable brands' public content and engagement),
> - **ad performance optimization** (reviews campaign data and recommends improvements),
> - **automated reporting** — generating decks, docs and spreadsheets, plus recurring tasks and reminders,
> - **cross-platform integration** across Facebook, Instagram, Meta Ads **and Google Workspace**,
> - delivered through meta.ai, the mobile app and a **new desktop app**, and *"It's free to get started with these features today."*
>
> **Read this against §13.8 and §12's ranking of willingness-to-pay.** Meta shipping free competitor benchmarking, ad-performance review and automated client reporting — with Google Workspace output — attacks the "agency/operator labour" and "transparency/reporting" revenue lines directly and sooner than the original draft assumed. It also erodes the "cross-account/vertical priors" story at the low end. It remains an assistant surface (chat, Ads Manager, desktop app) with **no announced API**, so it does not change the programmatic-automation picture — but it changes the *pricing* picture for anything sold to SMBs as reporting or account review.

**2. Meta Business Agent** (customer messaging, not ads). <https://about.fb.com/news/2026/06/meta-business-agent/> (updated 2026-06-03):
> "More than **one million businesses** are already using a Meta Business Agent on WhatsApp and Messenger"
> "there are more than **one billion active threads** with businesses on WhatsApp, Messenger and Instagram every day"
> "**getting started is free**. In the coming months, businesses will access the agent through **paid subscription offerings**"
> "**Meta Business Agent Platform**: ... It lets businesses connect to a growing suite of **hundreds of systems like Shopify, Zendesk, and Shopee** giving Business Agents the ability to take action on behalf of the business."

This is post-click / conversational commerce, **not campaign automation**. It is however the one place Meta has said it *will charge*.

**3. Business AIs** (SMB sales assistant). Per the Jan-2026 post: *"early traction for Business AIs in Mexico and the Philippines, with over one million weekly conversations already happening."*

**4. `biz_ai`** — an undocumented `AdCreativeFeaturesSpec` field. Almost certainly the ad-creative hook into the above. **UNVERIFIED.**

---

## 9. The ranking/ML infrastructure — how good is Meta's own optimiser now

This determines what you must *not* try to beat.

### 9.1 Andromeda (retrieval)
<https://engineering.fb.com/2024/12/02/production-engineering/meta-andromeda-advantage-automation-next-gen-personalized-ads-retrieval-engine/> (2024-12-02)

- Retrieval narrows **tens of millions of ad candidates → a few thousand**; it "processes three orders of magnitude more ads than subsequent stages."
- NVIDIA Grace Hopper + MTIA co-design; **10,000× increase in model capacity**; **+6% recall**, **+8% ads quality on selected segments**; **10× further inference efficiency** from model elasticity; **>3× end-to-end QPS**; **>100×** feature-extraction latency/throughput improvement over CPU components.
- Hierarchical index jointly trained with the retrieval model, explicitly built *"to support exponential ad creatives growth from Advantage+ creative."*
- Quantified Advantage+ effects cited in the same post: *"advertisers who did not previously use Advantage+ creative turned on its AI-driven targeting features, they experienced a **22% increase in ROAS**"*; *"businesses using image generation are seeing a **+7% increase in conversions**"*; *"more than a million advertisers used our generative AI (GenAI) tools to create **more than 15 million ads in a month**."*
- Forward-looking: *"another **1,000x** increase in model complexity."*

**The load-bearing sentence for your strategy:** Andromeda exists *specifically* to exploit creative volume. Meta built the retrieval layer on the assumption that advertisers will upload far more creative than a human could evaluate. **Creative volume is the input Meta's system is starved for and explicitly optimised to consume.**

### 9.2 GEM — Generative Ads Recommendation Model
<https://engineering.fb.com/2025/11/10/ml-applications/metas-generative-ads-model-gem-the-central-brain-accelerating-ads-recommendation-ai-innovation/> (2025-11-10)

- *"the largest foundation model for recommendation systems (RecSys) in the industry, trained at the scale of large language models."*
- **+5% ad conversions on Instagram, +3% on Facebook Feed in Q2** [2025].
- Architecture: enhanced **Wukong** stackable factorization machines for non-sequence features; pyramid-parallel offline sequence modelling; **InterFormer** interleaved sequence/cross-feature learning; multi-domain learning with per-surface heads.
- **4× more efficient** than the previous ranking generation per unit data/compute; knowledge transfer **2× the effectiveness of standard distillation** (Student Adapter, representation learning, parameter sharing) into hundreds of downstream vertical models; training stack **23× effective FLOPS**, **1.43× MFU**, **16× more GPUs**.
- Roadmap, verbatim: *"We will also evolve GEM to reason with inference-time scaling to optimize compute allocation, power intent-centric user journeys, and enable **agentic, insight-driven advertiser automation that drive higher ROAS**."*

Follow-up: <https://engineering.fb.com/2026/08/03/ml-applications/training-gem-at-llm-scale-meta-ads-recommendation-foundation-model/> (2026-08-03) — *"doubled end-to-end training efficiency to **20–25% MFU** while scaling training FLOPs **4x in 12 months**"*, trillions of sparse embedding params + billions of dense params, 5D parallelism, MXFP8 attention/MLP.

### 9.3 Multi-stage sequence modelling
<https://engineering.fb.com/2026/08/05/ml-applications/from-user-sequences-to-scaling-laws-a-multi-stage-architecture-for-metas-ads-ranking/> (2026-08-05)

- Splits into an **offline user model** (deep transformers, sequence lengths in the thousands, cached per-user embeddings, ad-independent) and an **online ranking model** (fresh signals + ad candidate, latency-bounded).
- **Dense tokenization** + **target-aware multi-head attention** replaces manual cross-feature engineering.
- *"cumulative lift of **6% in conversions on Instagram, 3% in conversions on Facebook and 3.5% in ad clicks on Facebook**."*
- **LLM-style log-linear scaling law**, *"no signs of saturation."*
- Key finding for creative strategy: *"**sequence diversity beats sequence homogeneity**. A balanced mix of action types (e.g., views, clicks, conversions) yields better results than sequences composed of a single action type."*
- Semantic content features from foundation models help specifically in **cold-start** (new ads, new advertisers).
- Paper: *"LLaTTE: Scaling Laws for Multi-Stage Sequence Modeling in Large-Scale Ads Recommendation."*

### 9.4 Meta Adaptive Ranking Model
<https://engineering.fb.com/2026/03/31/ml-applications/meta-adaptive-ranking-model-bending-the-inference-scaling-curve-to-serve-llm-scale-models-for-ads/> (2026-03-31) — request-centric routing that *"replaces a 'one-size-fits-all' inference approach with intelligent request routing"*, enabling **O(1T) parameter** runtime models at sub-second latency.

### 9.5 Meta Lattice
<https://www.facebook.com/business/news/ai-innovation-in-metas-ads-ranking-driving-advertiser-performance> (2025-03-27): *"Meta Lattice has increased ad quality by almost **12%** and increased ad conversions by up to **6%**."* Per the Jan-2026 post: *"With Meta Lattice, we consolidated Facebook Stories and other surfaces into the overall Facebook model; combined with back-end improvements, this drove a **12% increase in ads quality**."*

### 9.6 Ranking Engineer Agent (REA) — Meta automating its own ML engineers
<https://engineering.fb.com/2026/03/17/developer-tools/ranking-engineer-agent-rea-autonomous-ai-system-accelerating-meta-ads-ranking-innovation/> (2026-03-17)

- Autonomously generates hypotheses, launches training jobs, debugs failures, iterates; *"manages asynchronous workflows spanning days to weeks through a **hibernate-and-wake mechanism**, with human oversight at key strategic decision points."*
- *"**5x Engineering Output**: With REA-driven iteration, three engineers delivered proposals to launch improvements for eight models — work that historically required two engineers per model."*

**The pattern is worth stealing verbatim:** long-horizon agentic experimentation with hibernate-and-wake and human checkpoints at strategic decisions only. That is exactly the shape of an autonomous ad-optimisation agent.

### 9.7 Latest quarterly stats to calibrate against
<https://about.fb.com/news/2026/01/2026-ai-drives-performance/>
- *"In Q4 2025, we **doubled the GPUs** used to train ... GEM"*; new sequence-learning architecture drove *"a **3.5% lift in ad clicks on Facebook** and more than a **1% gain in conversions on Instagram** in Q4 2025."*
- *"We also launched a new run-time model across Instagram Feed, Stories, and Reels, increasing conversion rates by **3%** in Q4."*
- *"our latest Q4 model rollout drove a **24% increase in incremental conversions** compared to our standard attribution model, and the product reached a multi-billion-dollar annual run-rate just seven months after launch."* (**Incremental attribution** — see §11.)
- *"the combined revenue run-rate of our **video generation tools** hit **$10 billion**."*

**Verdict on Meta's optimiser:** targeting and delivery are effectively solved by Meta at a level no third party can approach — the compute gap is five or six orders of magnitude. **Any product thesis that depends on out-targeting Meta is dead on arrival.**

---

## 10. What is API-exposed vs Ads-Manager-only

| Capability | Marketing API | Ads Manager | Notes |
|---|---|---|---|
| Advantage+ campaign creation (via 3 levers) | ✅ | ✅ | `advantage_state_info` read-only |
| Advantage+ audience / placements / budget | ✅ | ✅ | |
| `creative_features_spec` opt-ins (~23 documented) | ✅ | ✅ | Ads Manager labels differ from API names |
| `text_generation`, `image_uncrop`, `image_background_gen` | ✅ | ✅ | |
| Preview of AI features (`creative_feature` param) | ✅ | ✅ | |
| Music (`asset_feed_spec.audios`) | ✅ | ✅ | |
| `format_transformation_spec` | ✅ | ✅ | |
| Opportunity score + recommendations (read) | ✅ | ✅ | API may return **fewer** than the UI |
| Recommendations (apply) | ✅ (subset) | ✅ (all) | Some types are deep-link-to-Ads-Manager only |
| `creative_fatigue` / `ad_recommendations` webhooks | ✅ | n/a | |
| Migration of ASC using `existing_customer_budget_percentage` | ❌ | ✅ | Explicitly Ads-Manager-only |
| Converting a legacy ASC to `ADVANTAGE_PLUS_SALES` by editing | ❌ | ✅ | Requires an Ads Manager edit + accepting CBO prompt |
| Meta AI business assistant | ❌ | ✅ | No public API |
| Ads MCP server rules | ✅ (limited availability) | ✅ (Business Suite settings) | Different host + version |
| **Video generation beyond animate/uncrop/dub** | ❌ | **UNVERIFIED** | See §5.5 |
| Muse Image-powered generation | (rolling into Advantage+ creative) | ✅ | No distinct API field announced |

---

## 11. Adjacent Meta-native automation you should know about (not to rebuild)

- **Ad Rules Engine** — Meta's native automated-rules system, fully API-exposed: `/act_<ID>/adrules_library`, `active_adrules`, `adrules_count_by_type`, with `evaluation_spec`, `execution_spec`, `change_spec`, trigger-based and schedule-based rules, `rebalance_budget` and ROAS rules. Docs root: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-rules>. **A basic "pause losers, scale winners" rules engine is free and first-party.** Do not sell that as your product.
- **Incremental attribution** — a Meta-native attribution model reported at *"a 24% increase in incremental conversions compared to our standard attribution model"* and a multi-billion-dollar run-rate (about.fb.com, Jan 2026). This directly attacks the "we measure true incrementality" pitch.
- **Conversion Lift / A/B tests** — exposed via the MCP server and Marketing API. Meta gives you the causal-measurement primitive for free.
- **Marketing Mix Modeling** endpoints, **Ad Volume API**, **Value Rules**, **Ad Set Budget Sharing**, **Cross-Channel Conversion Optimization** — all documented Marketing API surfaces.
- **`execution_options`** on ad/creative writes: `validate_only`, `synchronous_ad_review` (runs Ads Integrity validations — language checks, image text rule — without mutating), `include_recommendations`. **`["validate_only","synchronous_ad_review"]` is the single most valuable thing an autonomous system can use**: pre-flight policy review before spending a review cycle or risking an account flag.
- **Meta Ad Library search** via `ads_library_search` (MCP) — free competitor creative intelligence.
- **Meta Model API** (public preview, Muse Spark 1.1, OpenAI-compatible, 1M-token context) — <https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/>. Not an ads API, but a model vendor option.

---

## 12. Pricing: what Meta charges

**Meta charges nothing for any of it.** No line item exists for Advantage+, Advantage+ creative, generative AI creative features, opportunity score, recommendations, ad rules, webhooks, the Marketing API, the ads MCP server, or the ads CLI. Meta's revenue is the ad spend; the automation exists to increase and retain that spend. Music is free of charge and explicitly noted as such in the `MUSIC` recommendation: *"Allow Meta to automatically select and add music to your ads, **at no cost to you**."*

The **only** stated Meta monetisation of an AI business tool is Meta Business Agent: *"getting started is free. In the coming months, businesses will access the agent through **paid subscription offerings**, with options for businesses of every size."*

### Where third-party willingness-to-pay actually is

Ranked by my read of the evidence:

1. **Creative production cost displacement (strongest).** An advertiser paying a studio/agency $1.5k–$15k per video concept, or a freelancer $300–$800 per UGC-style ad, has a large, legible budget line. You are displacing a *cost*, not asking for a *new* budget. Meta's tools do not touch this line item because they cannot originate video. This is the only place where the buyer's existing spend is both large and clearly substitutable.
2. **Agency/operator labour (strong).** The manual work Meta has *not* automated: brief writing, offer/angle strategy, landing-page alignment, creative QA, cross-account learning, client reporting. Priced as $/account/month or % of spend. Note Meta is actively eroding this from below with the business assistant and MCP.
3. **Multi-platform (moderate).** Meta+TikTok+Google+Reddit in one system. Real, but each platform is shipping its own agent (TikTok Smart+, Google's read-only Ads MCP, Microsoft, X, Pinterest MCP alpha). The moat is integration breadth, which decays.
4. **Margin-aware optimisation (moderate but defensible).** See §13.7 — Meta structurally cannot do this. Willingness-to-pay is high per account but the buyer set (advertisers with real COGS variance and reliable margin data) is narrower than it looks.
5. **Reporting/transparency (weak as a standalone).** Free-tier commodity; Meta's own opportunity score plus a hundred dashboards compete. Bundle it, don't sell it.
6. **"An AI that manages your Meta ads" (weakest — now $0).** Meta gives this away at `mcp.facebook.com/ads` with better auth and better guardrails than you can offer. **Do not make this the headline of the product.**

Pricing shape implication: **% of ad spend** aligns you with Meta's objective (more spend) and against the advertiser's (more profit) — exactly the misalignment §13.7 says is your differentiator. **Per-creative or per-account-plus-outcome pricing is more consistent with the value story.**

---

## 13. Honest assessment: what a third-party autonomous platform actually adds

Each candidate, evaluated adversarially.

### 13.1 Creative volume & diversity beyond what Meta generates — **STRONG, and it is the core**

**For:** Meta's generative surface is *transformational*, not *generative*. Every documented feature takes an asset you already supplied and re-frames, re-crops, re-backgrounds, re-captions, translates, animates or overlays it. `text_generation` paraphrases *your* sentence (see the LED-TV output in §5.1 — five restatements of one idea, all price-led). Nothing in the API produces a **new concept**: a different hook, a different persona, a different objection handled, a different offer framing, a different narrative structure.

Meta's own infrastructure is explicitly starved for exactly this. Andromeda was built to absorb "exponential ad creatives growth"; the retrieval index is hierarchical *because* Meta expects more creatives than it can score flatly. The multi-stage sequence paper's finding that **"sequence diversity beats sequence homogeneity"** and that semantic content features matter most in **cold-start** both say: give the system genuinely distinct creatives and it will find the audience for each.

**Against:** More creative is not automatically better. `FRAGMENTATION_V3` shows Meta actively consolidating; the 150-combination ceiling on the old ASC and the >50-ads migration block hint at diminishing returns. Volume without diversity just burns budget in the learning phase. And Meta explicitly warns migrations reset learning.

**Verdict: build for diversity-per-unit-spend, not raw count.** Measure and optimise a concept-space diversity metric (distinct hook × persona × offer × format), not ad count. This is defensible because it requires taste and structure Meta's paraphraser does not have.

### 13.2 Brand/product fidelity — **STRONG, and Meta just conceded it**

Meta's own Muse Image launch post is an admission of prior failure. Advertiser quotes Meta chose to publish:
> *"With previous generations, I could always tell it was AI."*
> *"You'd be surprised how hard it is for AI to make our products look like ours—the compact shape, the cap finish, the size of our logo. Previous generations got those details slightly wrong every time."*

And Meta's 2023 post already flagged the structural issue:
> *"there is still work to do on delivering outputs customized to every brands' unique voice and visual style. We'll need to define new ways of partnering with brands and agencies to help train these models on brands' unique perspective."*

Three years later there is still **no brand-kit, no reference-image conditioning, no style-lock, and no per-advertiser fine-tune in the Marketing API.** `creative_features_spec` has no `customizations` for brand.

**Against:** Muse Image is explicitly designed to close this ("agentic visual reasoning and self-refinement", "preserve product integrity") and is rolling into Advantage+ creative now. The gap will narrow.

**Verdict: real today, narrowing.** Do not build a business on "our images look better." Build on **verifiable fidelity**: reference-conditioned generation, an automated product-identity check (does the generated pack shot match the SKU?), and a policy-and-brand gate before ACTIVE. Meta ships the preview API; it ships no judgement.

### 13.3 Cross-account learning — **REAL BUT OVERSTATED**

**For:** you can hold priors Meta will never hand any single advertiser: which hooks work in this vertical, what CPA band is achievable at this AOV, which offer structures convert, what creative refresh cadence a category needs. Meta's `SCALE_GOOD_CAMPAIGN` recommendation is literally peer-benchmark-based (*"compared to ad sets and campaigns with the same optimization goal that you or your peers have run"*) — so Meta agrees peer priors are valuable; it just won't expose them to you.

**Against:** Meta's cross-account learning operates at a scale you cannot touch — GEM trains on billions of daily interactions across all advertisers, and transfers to hundreds of downstream models. Anything you learn about *delivery* is already priced in. And there are real constraints: Meta Platform Terms restrict cross-advertiser data use; you must be careful that "cross-account learning" means *your own creative-performance meta-data*, not commingled advertiser data.

**Verdict: valid only at the strategy layer** (angles, offers, category benchmarks, creative-format priors) — never at the delivery layer. Frame it as your own creative-performance corpus, and check the Platform Terms before shipping it.

### 13.4 Angle/offer strategy — **STRONGEST DIFFERENTIATOR, and least contested**

There is **no Meta product, API field, or recommendation type** that reasons about *what to say*. Meta optimises the distribution of messages you supply. `MULTI_TEXT` asks you for more text options; `text_generation` paraphrases one; `GEN_AI_MVP` surfaces variations. None of them decide that a supplement brand should lead with a sleep-quality angle rather than an energy angle, or that the offer should be a bundle rather than a discount.

This maps directly onto the product's stated premise: the human supplies business/product info, budget and goals. Turning "what the business is" into a portfolio of *distinct testable propositions* is the highest-leverage, least-automated step in the whole funnel, and it is the step Meta has never claimed.

**Against:** it is also the hardest to evaluate and the easiest to fake. You will need an explicit angle taxonomy, per-angle attribution (one angle → many creatives → measurable performance), and a bandit over angles, or it degenerates into "the LLM wrote some copy."

**Verdict: make this the spine of the product.** Model angle as a first-class entity with its own ID, hypothesis, and performance record.

### 13.5 Landing-page + funnel continuity — **STRONG, and structurally uncontested**

Meta's automation stops at the click. The only funnel-adjacent things it ships are `reveal_details_over_time` (scrapes your page for an in-ad reveal), `site_links` as a format-automation data source, `LANDING_PAGE_VIEW_OPTIMIZATION_GOAL` (optimise for people who wait for the page to load), and the Shops-ads default flip in v26.0. **Meta cannot edit your landing page.** Ad-to-page message match is one of the largest controllable levers on blended CVR and it is entirely outside Meta's reach.

Note the v26.0 gotcha here: `destination_type` now defaults to `WEBSITE_AND_SHOP` for advertisers with a shop, which **silently changes where traffic lands** and therefore what "funnel continuity" even means. An autonomous platform must set this explicitly.

**Verdict: genuine white space.** Angle → creative → landing page variant, generated and measured as one unit, is something Meta structurally will not do.

### 13.6 Multi-platform — **REAL, DECAYING**

Every major platform now has or is building an agent surface (§7.3). The advertiser-side value of "one brain across platforms" is real, but it is an integration moat, and integration moats erode. Treat it as a distribution/expansion story, not the core thesis.

### 13.7 Meta optimises for ITS objective, not the advertiser's margin — **TRUE, IMPORTANT, AND THE MOST DEFENSIBLE ECONOMIC ARGUMENT**

The mechanics, precisely:
- Meta's bid strategies optimise **conversions**, **conversion value**, or **ROAS floor** (`roas_average_floor`). None of them optimise **contribution margin**.
- ROAS is revenue ÷ spend. If your gross margin varies by SKU (it always does), Advantage+ will happily push spend toward high-revenue, low-margin SKUs. Meta's `PRODUCT_SET_BOOSTING` recommendation *"enables Meta to show products from your broader catalog beyond your specified product set"* — which is precisely a margin-blind expansion of what you sell.
- `SCALE_GOOD_CAMPAIGN` recommends **budget increases**, quantified in cents, applied with one API call. `BUDGET_LIMITED` tells you your budget is capping results. Meta has no notion of your cash conversion cycle, inventory depth, or the marginal CAC at which growth stops being worth it.
- Advantage+ audience deliberately relaxes toward existing customers — which is why `existing_customer_budget_percentage` existed at all, and Meta has now **removed** it, pushing the new/existing split back onto you (§2.5).

**How to actually exploit it (and this is the engineering, not the pitch):**
1. Feed Meta a **margin-weighted conversion value** rather than revenue. Use the Conversions API to send `value` as contribution margin (or a margin-scaled proxy), then run `VALUE` optimisation / `LOWEST_COST_WITH_MIN_ROAS` against that. Meta will then optimise the thing you care about while thinking it is optimising revenue. This is the single highest-leverage architectural decision in the whole platform.
2. Maintain product-set partitions by margin band and control spend allocation across them at the campaign level, rather than letting `PRODUCT_SET_BOOSTING` flatten them.
3. Implement your own marginal-CAC stopping rule on top of `SCALE_GOOD_CAMPAIGN` — accept its *signal*, reject its *default*.

**Against:** the advertiser must actually have trustworthy margin data. Many do not. And a margin-weighted value signal is sparser and noisier than revenue, which hurts learning. There is a real trade-off between signal fidelity and signal volume.

**Verdict: the strongest economic story, but it is a data-integration product before it is an AI product.**

### 13.8 Transparency/reporting — **WEAK STANDALONE**

Meta already gives you opportunity score, typed recommendations with `lift_estimate` and `opportunity_score_lift`, activity logs via MCP, fatigue webhooks, and full Insights breakdowns. A dashboard is table stakes. The one non-obvious reporting asset you *can* own: **per-angle and per-concept attribution**, which Meta cannot produce because it does not know your angles exist.

### 13.9 Summary scorecard

| Candidate | Verdict | Durability |
|---|---|---|
| Angle/offer strategy | **Core thesis** | High — Meta has never claimed it |
| Creative origination at volume (esp. video) | **Core thesis** | High — Meta transforms, doesn't originate |
| Margin-aware objective (via CAPI value shaping) | **Core thesis** | High — structural conflict of interest |
| Landing-page/funnel continuity | Strong | High — outside Meta's reach |
| Brand/product fidelity | Strong today | Medium — Muse Image is closing it |
| Cross-account learning (strategy layer only) | Moderate | Medium |
| Multi-platform | Moderate | Low–Medium — everyone is shipping agents |
| Transparency/reporting | Table stakes | Low |
| "AI that manages your Meta ads" | **Do not build** | **Zero — Meta gives it away** |
| Better targeting | **Do not build** | Zero — you lose by 5 orders of magnitude |
| Rules engine (pause losers / scale winners) | **Do not build** | Zero — free first-party Ad Rules Engine |

---

## 14. Gotchas (each of these costs a day or more)

0. **[ADDED BY FACT-CHECK] The Graph API and the Marketing API publish DIFFERENT version-expiration tables, and they disagree by ~16 months.** The Graph API changelog says v24.0 is available until 2028-02-18; the Marketing API changelog says v24.0 **expires 2026-10-06**. Marketing API v23.0 **already expired on 2026-06-09**. Always read <https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/versions>, never the Graph API table, when planning an ads-platform upgrade cadence. (§1)
0b. **[ADDED BY FACT-CHECK] The `AdCreativeFeaturesSpec` node reference is NOT a complete inventory.** Seven documented, working features — including `image_uncrop`, `video_uncrop`, `video_filtering`, `enhance_cta`, `video_auto_crop`, `image_brightness_and_contrast`, `image_text_translation` — are absent from it. Do not generate your feature enum from the reference page. (§4.3)
0c. **[ADDED BY FACT-CHECK] Only `adapt_to_placement` is opt-in by default.** `description_automation` and `inline_comment` are NOT, contrary to the original draft. If you were relying on them being on, they are off. (§4.2)
1. **Docs moved.** `/docs/marketing-api/<guide>` → `/documentation/ads-commerce/marketing-api/<guide>`. Append `.md` to any documentation path for a clean LLM-readable version (some pages 500 on `.md`; fall back to HTML). **Note (fact-check): the `.md` variant 500s on the webhook pages, and `developers.facebook.com/docs/marketing-api/reference/*` paths intermittently return HTTP 400 to non-browser clients. `/documentation/...` HTML paths fetch reliably.**
2. **`advantage_state` is read-only.** POSTing it does nothing. Ditto `smart_promotion_type` — you cannot set it back to `GUIDED_CREATION`.
3. **`smart_promotion_type=AUTOMATED_SHOPPING_ADS` errors on every API version since v25.0**, not just v25.0+. Version pinning does not save you.
4. **Advantage+ requires ALL THREE levers.** Setting one placement exclusion on one ad set silently drops the whole campaign to `advantage_state: DISABLED`. Poll `advantage_state_info` after every write.
5. **Placement exclusions at the *account* level are fine**; at the ad-set level they are fatal to Advantage+ eligibility. Use `/act_<ID>/account_controls`.
6. **`advantage_audience` must be explicit on ad-set create since v23.0** if targeting is neither default nor relaxed; otherwise the call errors. On v26.0 this is hard-required for HEC-F ad sets (`ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG`).
7. **With Advantage+ audience on, `age_min` may only be 18–25 and `age_max` cannot be set** (fixed 65). Passing 30–50 silently loses your intent or errors.
8. **The Get Started doc's own curl example uses `"image_template"` (singular) while its feature table says `image_templates` (plural).** The plural is the field in `AdCreativeFeaturesSpec`; the singular appears in the deprecated standard-enhancements sub-feature list. Use the plural and verify by reading the spec back.
9. **Ineligible features are silently stripped** from `creative_features_spec`. Always GET and diff. Otherwise your feature-vs-performance analysis is measuring features that never ran.
10. **`standard_enhancements` and sub-features may appear in a GET even if you never sent them.** Only `OPT_IN` matters.
11. **AI-generated features force a PAUSED→preview→ACTIVE flow.** If your pipeline creates ads ACTIVE, opting into `image_uncrop`/`image_background_gen`/`text_generation`/`image_animation` breaks it. Also, `POST /ads` defaults to PAUSED anyway.
12. **`text_generation` mutates your creative** — it injects `asset_feed_spec.bodies` with `optimization_type: "DEGREES_OF_FREEDOM"`. If you later read `object_story_spec.link_data.message` expecting your original copy, you will be reading one of five machine paraphrases. And there is **no regenerate**: reject = rebuild the creative.
13. **`image_background_gen` only works with DPA / Advantage+ catalog ads on Mobile Feed.** Non-catalog advertisers cannot use it via API.
14. **`translate_voiceover` is English→Spanish only**, preview shows only the first 6 seconds, the full render happens **after** publish, and the output **cannot be edited or regenerated**.
15. **Music is not in `creative_features_spec`.** It is `asset_feed_spec.audios: [{"type":"random"}]`. Opt out by sending it empty.
16. **`format_transformation_spec` is a top-level creative field**, not nested under `degrees_of_freedom_spec`.
17. **Ads MCP rules use a different host and a pinned version**: `https://ads-api.facebook.com/v25.0/...`, not `graph.facebook.com`. `business_management`-only tokens 401 on the catalog rules endpoint. Not enrolled → error code 10 (ad account) / HTTP 403 (catalog).
18. **`GET /recommendations` omits `lift_estimate` and `body` by default.** You must request `fields=recommendation_content`.
19. **`recommendation_signature` expires.** Apply promptly or the POST fails.
20. **Recommendation apply amounts are in cents** (`additional_budget: 6000` = $60).
21. **The API returns fewer recommendations than Ads Manager**, by Meta's own admission. Never present API recommendation count as "everything Meta suggests."
22. **Delivery Estimate loses `daily_outcomes_curve`, `budget_guardrail`, `estimate_dau` on 2026-10-27 with no replacement.** Build your own budget-response model now.
23. **v26.0 flips `destination_spec.destination_type` to `WEBSITE_AND_SHOP` by default** for advertisers with a shop. Set it explicitly (`WEBSITE_AND_SHOP_OPT_OUT`) or your traffic silently changes destination.
24. **Migration forces the learning phase.** `migrate_to_advantage_plus` resets learnings with no workaround — never migrate a well-performing campaign mid-flight.
25. **>50 ads in an ASC ad set = permanently unmigratable. >70 ad sets under CBO = you can no longer change bid strategy or disable CBO.**
26. **`LOWEST_COST_WITH_MIN_ROAS` is a one-way door** — you cannot switch bid strategy afterwards.
27. **Optimization goal is immutable once a campaign has delivered.** Design for create-and-swap.
28. **`pacing_type` belongs at campaign level under CBO**, not ad set.
29. **`existing_customer_budget_percentage` campaigns get paused at v26.0** and cannot be migrated via API at all.
30. **Meta's Ads Manager labels ≠ API field names** (`image_touchups` → "Visual touch-ups", `adapt_to_placement` → "Image touch-ups" — two *different* API fields map to confusingly similar UI labels). Store both mappings or your support tickets will be unanswerable.
31. **Use `execution_options: ["validate_only","synchronous_ad_review"]`** before every real ad write. It runs Ads Integrity checks (language, 20% text rule) without mutating. Skipping this is how autonomous systems get accounts restricted.

---

## 15. Open questions / UNVERIFIED

1. **Does Meta ship an Ads-Manager-only generative *video* creator for ads?** The Jan-2026 newsroom claim of a "$10 billion combined revenue run-rate of our video generation tools" and 2025–26 trade headlines suggest something beyond `image_animation`. No primary Meta source retrieved. **Highest-priority follow-up** — it determines how large the video gap actually is.
   - **Fact-check 2026-09-02 — still open, but the negative got stronger.** Three further primary Meta sources published *after* the Jan-2026 post were checked: Muse Image for businesses (2026-07-07), "Meta AI features for small businesses" (2026-08-19), and the Laura Geller creative-volume performance spotlight (2026-08-11). **None describes any video-generation capability for ads.** The Muse Image post enumerates Advantage+ creative's image-gen capabilities as exactly *"generating new backgrounds around product images, ... creating full lifestyle image variations inspired by existing ads, ... producing static images directly from video creative"* — video→image, never image→video. The Laura Geller case study, which is *specifically about creative volume*, credits AI only with turning *"one ad into six variations ... new hooks, crops, captions"* and names only Advantage+, Andromeda and value optimization. Four primary sources across eight months, zero mentions of generative video for ads. **The $10B figure remains unreconciled and most plausibly counts ad spend on ads touched by the transformational video features.** The build conclusion in §5.5 stands.
2. **Exact semantics of the $10B "video generation tools" run-rate** — ad spend on ads using the tools, vs something else. Meta's phrasing is the ad-spend construction, but unconfirmed.
3. **`biz_ai`, `music_generation`, `multi_photo_to_video`, `video_to_image`, `video_highlights`, `show_summary`, `replace_media_text`, `creative_stickers` availability and eligibility** — present in `AdCreativeFeaturesSpec` with no documentation. Need live API probing on a real ad account.
4. **When Muse Image actually lands in Advantage+ creative, and whether it gets a distinct API field** or silently upgrades `image_background_gen` / adds a lifestyle-variation feature.
5. **Whether the Meta AI business assistant can take write actions**, and whether it will get an API.
6. **Whether "comment summaries" is `show_summary`** — inferred, not confirmed.
7. **Full ads MCP tool inventory** — the `ads-mcp-server-tools` page returned only a heading; the six other category pages (reporting, catalog, signals, help, A/B tests, activity logs) were not read in this session.
8. **The ads CLI** — doc tree exists at `/documentation/ads-commerce/ads-ai-connectors/ads-cli/{ads-cli-overview,setup-get-started,setup-configuration,command-reference,ad-creatives,insights,datasets-and-catalogs,tutorials-and-recipes}` but was not read.
9. **Whether ads MCP server rules apply to non-MCP Marketing API calls.** Reading of the doc says no (they govern "agent actions" through the MCP server), but this is load-bearing for a compliance story and should be confirmed.
10. **Marketing API rate limits and access tiers** for a multi-tenant autonomous platform — not covered here (`/documentation/ads-commerce/marketing-api/overview/rate-limiting`).
11. **Formal status of AI Sandbox** — no post-2023 Meta reference found.
12. **Whether Advantage+ campaigns are eligible in all Special Ad Categories.** The doc says access for Housing/Employment/Financial Products *"is currently being rolled out"*; ineligible campaigns migrate into "a similar structure using broad targeting."
13. ~~**`opportunity_score_weight` semantics** — described only as "budget-based weighting."~~ **RESOLVED by fact-check 2026-09-02:** the AdAccount reference defines it as *"the remaining budget for the ad account in cents, computed daily. This can be used with other ad accounts within the same business to compute the weighted opportunity score for a business."* (§6.4b)
14. **The exact Ad Creative Generative AI Terms text** (<https://www.facebook.com/legal/terms/ad_creative_generative_ai_terms>) — not fetched; must be read before shipping AI creative at scale, especially regarding indemnity and permitted automated publishing.

---

## 16. Source index

**Meta developer documentation**
- Graph/Marketing API changelog — <https://developers.facebook.com/docs/graph-api/changelog>
- v26.0 changelog — <https://developers.facebook.com/docs/graph-api/changelog/version26.0>
- Advantage+ Campaign Experience for Sales, App, and Leads (*Updated Jun 17, 2026*) — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-campaigns>
- Advantage+ Shopping Campaigns (legacy) — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-shopping-campaigns>
- Advantage+ App Campaigns & Catalog Ads — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads/advantage-app-campaigns>
- Get Started with Advantage+ Creative — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/advantage-creative/get-started>
- Generative AI Features on Marketing API — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/generative-ai-features>
- Format Automation — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/format-automation>
- Advantage+ Creative for Catalog — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-creative-for-catalog>
- Standard Enhancements (deprecated) — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads/standard-enhancements>
- Product Extensions — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads/product-extensions>
- Advantage+ audience — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/targeting-expansion/advantage-audience>
- Advantage Targeting — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/advantage-targeting>
- Advantage Campaign Budget — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/bidding/guides/advantage-campaign-budget>
- Opportunity Score and Recommendations — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/performance-recommendations>
- Creative fatigue webhook (*Updated Jul 6, 2026*) — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/creative-fatigue>
- Ad recommendations webhook — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/ad-recommendations>
- Ad Rules Engine — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-rules>
- Ads MCP Server overview — <https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview>
- Ads MCP Server get started — <https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started>
- Ads MCP Server ad creation tools — <https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-tools-ad-creation-and-management>
- Ads MCP Server rules (*Updated Aug 12, 2026*) — <https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-rules-best-practices>
- Campaign node reference — <https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/>
- AdSet node reference — <https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/>
- AdCreative node reference — <https://developers.facebook.com/docs/marketing-api/reference/ad-creative/>
- AdCreativeDegreesOfFreedomSpec — <https://developers.facebook.com/docs/marketing-api/reference/ad-creative-degrees-of-freedom-spec/>
- AdCreativeFeaturesSpec (46 fields) — <https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/>
- AdAccount node reference (`opportunity_score`, `opportunity_score_weight`) — <https://developers.facebook.com/docs/marketing-api/reference/ad-account/>
- **Marketing API versions list (expiration dates — NOT the Graph API table)** — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/versions> *(added by fact-check)*
- **Marketing API versioning policy (90-day deprecation schedule)** — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/versioning> *(added by fact-check)*
- **Performance Recommendations History API (`/act_<ID>/opportunity_score_history`)** — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/performance-recommendations-history-api> *(added by fact-check)*
- Ads MCP Server get started (permissions list verified verbatim, *Updated: Jul 14, 2026*) — <https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started>

**Meta product announcements**
- Meta Ads AI Connectors (2026-04-29, updated 2026-07-16) — <https://www.facebook.com/business/news/meta-ads-ai-connectors>
- Muse Image for businesses (2026-07-07) — <https://www.facebook.com/business/news/muse-image-for-businesses>
- **Meta AI features for small businesses (2026-08-19)** — <https://www.facebook.com/business/news/meta-ai-for-small-businesses> *(added by fact-check)*
- **Performance Spotlight: Laura Geller, creative volume (2026-08-11)** — <https://www.facebook.com/business/news/laura-geller-creative-volume> *(added by fact-check; checked for evidence of AI video generation — none found)*
- Opportunity score GA (2025-06-09) — <https://www.facebook.com/business/news/elevate-your-campaign-performance-with-opportunity-score>
- AI innovation in Meta's ads ranking (2025-03-27) — <https://www.facebook.com/business/news/ai-innovation-in-metas-ads-ranking-driving-advertiser-performance>
- Generative AI features for ads (2023-10-04) — <https://www.facebook.com/business/news/generative-ai-features-for-ads-coming-to-all-advertisers>
- 2026: AI drives performance (2026-01) — <https://about.fb.com/news/2026/01/2026-ai-drives-performance/>
- Meta Business Agent (2026-06) — <https://about.fb.com/news/2026/06/meta-business-agent/>
- Gen-AI transparency in Meta's ads products (2025-02) — <https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/>
- Muse Image / Muse Video (2026-07-05) — <https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/>
- Muse Spark 1.1 + Meta Model API — <https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/>

**Meta engineering**
- Andromeda (2024-12-02) — <https://engineering.fb.com/2024/12/02/production-engineering/meta-andromeda-advantage-automation-next-gen-personalized-ads-retrieval-engine/>
- GEM (2025-11-10) — <https://engineering.fb.com/2025/11/10/ml-applications/metas-generative-ads-model-gem-the-central-brain-accelerating-ads-recommendation-ai-innovation/>
- Training GEM at LLM scale (2026-08-03) — <https://engineering.fb.com/2026/08/03/ml-applications/training-gem-at-llm-scale-meta-ads-recommendation-foundation-model/>
- Multi-stage sequence architecture / LLaTTE (2026-08-05) — <https://engineering.fb.com/2026/08/05/ml-applications/from-user-sequences-to-scaling-laws-a-multi-stage-architecture-for-metas-ads-ranking/>
- Meta Adaptive Ranking Model (2026-03-31) — <https://engineering.fb.com/2026/03/31/ml-applications/meta-adaptive-ranking-model-bending-the-inference-scaling-curve-to-serve-llm-scale-models-for-ads/>
- Ranking Engineer Agent (2026-03-17) — <https://engineering.fb.com/2026/03/17/developer-tools/ranking-engineer-agent-rea-autonomous-ai-system-accelerating-meta-ads-ranking-innovation/>

**Secondary / trade (used only for timeline corroboration)**
- PPC Land, Innovid + Meta ads MCP (2026-09-01) — <https://ppc.land/innovid-gains-meta-campaign-data-in-nivo-through-ads-mcp-integration/>

---

## Fact-check log

**Adversarial re-verification, 2026-09-02.** 18 load-bearing claims were re-checked against Meta primary sources only (`developers.facebook.com`, `engineering.fb.com`, `about.fb.com`, `ai.meta.com`, `facebook.com/business/news`). No secondary source was accepted as proof. Every quotation below was re-read at the source on this date.

**Method constraint:** the search-engine budget was exhausted at the start of this pass, so verification was done by direct fetch of the URLs named in §16 plus URLs discovered from Meta's own doc navigation. Two consequences: (a) I could confirm or refute what the docs *say*, but could not do open-web discovery for things Meta has published elsewhere; (b) `developers.facebook.com/docs/marketing-api/reference/*` paths intermittently return HTTP 400 to non-browser clients, so the node-reference field counts below are less firmly established than the guide-page findings.

### Verdict table

| # | Claim | Verdict |
|---|---|---|
| 1 | v26.0 latest (2026-07-29); v24.0 sunsets 2026-10-06; auto-upgrade 2026-07-29 | **CONFIRMED on fact, REFUTED on sourcing** — see below |
| 2 | ASC/AAC uncreatable on any version since v25.0; uneditable at v26.0 | **CONFIRMED** (verbatim) |
| 3 | `advantage_state` read-only, derived from three levers | **CONFIRMED** (verbatim, incl. all four `advantage_state_info` sub-fields, all four `bid_strategy` enums, and `GUIDED_CREATION`) |
| 4 | ~23 documented creative transforms + ~30 undocumented | **CONFIRMED with two corrections** — see below |
| 5 | No text-to-video / image-to-video in Marketing API | **CONFIRMED** (and strengthened) |
| 6 | Muse Video is preview, not in ads; Muse Image coming to Advantage+ creative | **CONFIRMED** (verbatim, both posts) |
| 7 | $10B run-rate for "video generation tools", meaning unresolved | **CONFIRMED** (verbatim) — interpretation correctly flagged as unresolved |
| 8 | First-party ads MCP server with write capability, free | **CONFIRMED** (verbatim: URL, all 7 permissions, all write tools, paused-state guarantee, both dates) |
| 9 | Opportunity score + read/apply recommendations API | **CONFIRMED, but materially incomplete** — see below |
| 10 | `creative_fatigue` and `ad_recommendations` webhooks | **CONFIRMED** (both payloads byte-for-byte; both pages "Updated: Jul 6, 2026") |
| 11 | Mandatory PAUSED → preview → ACTIVE for AI features | **CONFIRMED** (verbatim, incl. `{eligible, pending, ineligible}` and the no-`transformation_spec` rule) |
| 12 | `text_generation` mutates creative, no regenerate | **CONFIRMED** (verbatim, incl. the 5 LED-TV sample bodies) |
| 13 | `image_background_gen` is DPA/catalog + Mobile Feed only | **CONFIRMED** (verbatim, incl. `PENDING` stock preview and the 5 `image_uncrop` placements) |
| 14 | `advantage_audience` explicit since v23.0; HEC-F hard-required at v26.0 | **CONFIRMED** (one minor imprecision) |
| 15 | Lookalike + detailed-targeting expansion force-enabled | **CONFIRMED** (and the enforced list is longer than recorded) |
| 16 | Ranking stack is LLM-scale, improving several % / quarter | **CONFIRMED** (Andromeda, GEM, LLaTTE, MFU figures all verbatim) |
| 17 | Meta charges $0; only Meta Business Agent is announced paid | **CONFIRMED** (verbatim) |
| 18 | Delivery Estimate loses budget fields 2026-10-27, no replacement | **CONFIRMED** (verbatim, incl. the date) |

### What was actually wrong

**1. The version-expiration table was sourced from the wrong API (§1) — the single most consequential error found.**
The draft cited <https://developers.facebook.com/docs/graph-api/changelog> for "v24.0 available until 2026-10-06". That page says no such thing: it lists v24.0 as **available until February 18, 2028**. The 2026-10-06 date is real, but it comes from the *Marketing API* changelog (<https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/versions>), which keeps a separate and far more aggressive schedule — *"Marketing API is versioned on a 90-day deprecation schedule, whereas Platform API has core and extended APIs with a 2 year guarantee for core APIs."*
The conclusion ("build for v26.0, don't pin v24.0") was right for the right underlying reason, but anyone who followed the cited link to check would have found the opposite number and concluded the warning was wrong. **Also newly surfaced and previously unrecorded: Marketing API v23.0 expired on 2026-06-09 — it is already dead — and v25.0/v26.0 expirations are listed as TBD, not 2028.** §1 has been rewritten with both tables side by side, and Gotcha 0 added.

**2. Two creative features were wrongly recorded as opt-in by default (§4.2).**
`description_automation` and `inline_comment` were both marked "Default OPT_IN". The Get Started guide describes them as ordinary optional opt-ins; **`adapt_to_placement` is the only feature the guide states is on by default** (*"Default is opt-in."*). Corrected in the table. This matters because a build that assumed catalog descriptions and relevant comments were already running would have silently shipped without them.

**3. The `AdCreativeFeaturesSpec` node reference is not the inventory the draft treated it as (§4.3).**
The draft recorded the reference→guide gap (30 undocumented fields) but not the guide→reference gap. **Seven documented, previewable, shipping features are absent from the node reference entirely:** `enhance_cta`, `image_brightness_and_contrast`, `image_text_translation`, `image_uncrop`, `video_auto_crop`, `video_filtering`, `video_uncrop`. Two are AI-generated features and one (`image_uncrop`) has its own dedicated generative-AI guide. Generating a feature enum from the reference page would have silently dropped image expansion and video uncrop. Added as Gotcha 0b.
**The exact reference field count is now marked UNVERIFIED.** Repeated extractions returned 45, 46 and 51; the page would not fetch cleanly enough to settle it. The "46" in §4.3 is the original count and should not be relied on.

**4. Minor imprecisions, corrected or flagged in place:**
- §0 TL;DR said "~25 named" creative transforms; the verified figure is **exactly 23 documented**, seven of them AI-generated. Corrected.
- The v26.0 changelog names the affected special categories as *"Housing, Employment, or Financial Products"*; the draft wrote "Housing / Employment / **Credit** / Financial-Products". "Credit" was not seen in the fetched changelog text. Low-stakes (Credit is a standard Special Ad Category), but the enum-name-level claim is **UNCERTAIN**.
- The Muse Image / Muse Video announcement on `ai.meta.com` is dated **July 7, 2026** on retrieval, not 2026-07-05 as recorded in §5.5. **UNCERTAIN** — same day as the business-news post, so one of the two dates in the draft is off by two days. Immaterial to any build decision.
- The claim summary under review conflated GEM's "23× effective training FLOPS" (Nov-2025 post) with "20–25% MFU / 4× FLOPs in 12 months" (Aug-2026 post). **§9.2 of this document already had it right** — both figures verified verbatim at their respective sources. No change needed.
- §3.2's list of optimization goals with enforced lookalike/detailed-targeting is correct but **incomplete**: the doc also names Conversations, Replies, Messaging purchase conversions, Research poll responses, In app value, Reminder set, and Social impressions. The draft said "including", so it is not an error — but the enforcement is broader than the list implies.

### What was missed (added to the document)

**A. The Performance Recommendations History API — an entire endpoint (§6.4b).**
`GET /act_<AD_ACCOUNT_ID>/opportunity_score_history` returns *"the daily history of an ad account's Opportunity Score over a configurable time range, with optional explainability that surfaces the campaign-level changes driving each score movement."* With `get_reason=true` it returns a per-day `changelog` carrying `campaign_id`, `score_change`, `ad_object_id`, `ad_object_type`, `budget_then`/`budget_now`, and `eligible_recommendation_types_then`/`_now` and `applied_recommendation_types_then`/`_now`. Window capped at 45 days; two-day data latency.
This is strategically significant and the draft's §6 conclusion is incomplete without it: Meta gives you not just a score and a recommendation list, but a **causally-annotated audit trail of what changed and which recommendations were applied**. Because the window is 45 days, Meta will not retain it for you — an autonomous platform should poll and warehouse it from day one, and use it to measure whether applying Meta's own recommendations actually helps a given account.

**B. Six recommendation fields the draft never recorded, including a priority score (§6.2).**
The `ad_recommendations` webhook doc prescribes `fields=recommendation_type,title,message,importance,estimated_impact,blame_field,object_id,recommendation_data` and explains them verbatim: *"`importance` supports prioritization or auto-apply rules, `estimated_impact` projects the lift if you apply the change, `blame_field` names the setting to change, and `recommendation_data` holds the structured suggested values."* The endpoint also supports server-side `filtering=[{"field":"object_id","operator":"EQUAL","value":"..."}]`. Meta is shipping an auto-apply policy surface — which setting, what value, how much lift, how urgent — and the draft's §6 field list omitted all four of the decision-relevant fields.

**C. Meta AI for small businesses, 2026-08-19 (§8) — the most recent competitive move, published after the draft's newest §8 source.**
<https://www.facebook.com/business/news/meta-ai-for-small-businesses> announces free SMB features including organic content analysis, **competitive benchmarking against comparable brands**, ad performance review with recommendations, and **automated reporting that generates decks, docs and spreadsheets** with recurring tasks — integrated across Facebook, Instagram, Meta Ads **and Google Workspace**, via meta.ai, mobile and a new desktop app. *"It's free to get started with these features today."*
This lands directly on two of §12's ranked revenue lines — "agency/operator labour" (#2) and "transparency/reporting" (#5) — and on §13.3's cross-account-priors story at the SMB end. It is assistant-surface only with no announced API, so it does not change the programmatic picture, but §12's durability estimates for reporting and account-review revenue should be revised down.

**D. Doc-fetch reliability notes (Gotcha 1).** The `.md` variant trick fails (HTTP 500) on the webhook pages, and `developers.facebook.com/docs/marketing-api/reference/*` intermittently returns HTTP 400 to non-browser clients while `/documentation/...` HTML paths fetch reliably. Relevant if any part of the build scrapes Meta docs.

### What remains unverified after this pass

1. **Exact field count of `AdCreativeFeaturesSpec`** — 45 / 46 / 51 across extractions; page would not fetch cleanly. The 30 undocumented field *names* were confirmed present; only the total is in doubt.
2. **Whether "Credit" appears alongside Housing/Employment/Financial Products** in the v26.0 `ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG` scope.
3. **Whether an Ads-Manager-only generative video tool exists.** Four primary Meta sources across Jan–Aug 2026 were checked; none mentions one. Still formally open only because the $10B figure is unexplained, but the evidence now leans firmly toward "no such tool", and toward the $10B being ad spend on ads using the transformational video features.
4. **The `ai.meta.com` Muse post date** (July 5 vs July 7, 2026).
5. **Everything in §15 that requires a live ad account** — undocumented feature eligibility (`biz_ai`, `music_generation`, `multi_photo_to_video`, `video_to_image`, `video_highlights`, `show_summary`, `replace_media_text`), the full MCP tool inventory beyond the ad-creation category, the ads CLI, and Marketing API rate limits. None of these can be settled from documentation alone; they need API probing.
6. **Ads MCP server rules host/version pinning (`ads-api.facebook.com/v25.0`)** — recorded from the rules doc but not independently re-fetched in this pass. Given finding #1 above (two different version tables), the v25.0 pin on a *third* host deserves its own re-check before it is coded against.

**Net assessment.** The dossier held up well: 15 of 18 claims confirmed outright, most of them verbatim against the exact quoted text, including every quotation I was able to reach. The errors found are one sourcing error with a real operational trap behind it (the two version tables), two feature-default errors, one incomplete-inventory error, and a set of omissions in §6 that understate how much of the optimisation loop Meta has already shipped. No claim was fabricated; nothing was confirmed that turned out not to exist.
