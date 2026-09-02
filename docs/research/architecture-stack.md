# Architecture, SDKs & Operational Engineering

**Research dossier — Meta ad automation platform**
Compiled 2026-09-02. Every non-obvious claim carries a source URL. Facts marked **UNVERIFIED** could not be confirmed against a primary source in this session and must not be built on without checking.

Two classes of source are used and distinguished throughout:

- **Docs** — `developers.facebook.com`, vendor documentation. Authoritative for policy and behaviour.
- **SDK codegen** — `facebook-python-business-sdk` `main` branch (v26.0.1). These files are *auto-generated from Meta's internal API spec* ("This class is auto-generated... we'll fix in our codegen framework"), which makes them the most reliable public source for **exact field names and enum values** — frequently more complete and more current than the HTML reference pages. Where the two disagree on an enum list, trust the SDK.

---

## 0. Executive recommendation

| Concern | Recommendation | One-line reason |
|---|---|---|
| Language | **TypeScript for orchestration + API surface; Python for anything touching ML/video tooling** | The Node Meta SDK is unusable (§1); you are hand-rolling HTTP anyway, so TS's type system is the asset. Python keeps the option of `facebook-business` as an oracle. |
| Meta API access | **Hand-rolled typed HTTP client**, with `facebook-python-business-sdk` vendored as a *codegen source*, not a runtime dependency | §1.4 |
| Orchestration | **Temporal** (Cloud, Essentials tier) | Only engine here that gives unbounded durable sleep + first-class dedupe on workflow id + signals for human-in-loop + local replay testing, without a per-step billing model that punishes polling. §2 |
| Idempotency | **Deterministic idempotency key → Temporal workflow id + Meta AdLabel reconciliation + local intent ledger** | The Graph API has *no* idempotency key. §3 |
| Storage | **Cloudflare R2** for renders and derivatives, content-addressed by SHA-256 | Zero egress; Meta pulls video via `file_url` at no cost. §5 |
| Secrets | **AWS KMS envelope encryption**, one CMK per region + per-tenant data keys, ciphertext in Postgres | $1/key/month; the compliance obligation is explicit in Meta Platform Terms §6.a.iv. §6 |
| Metrics store | **Postgres, monthly-partitioned append-only snapshot table**, keyed by `(ad_id, date, attribution_setting, snapshot_taken_at)` | Attribution restates for ~28 days; "latest state" is a lie. §4.4 |

---

## 1. Official Meta SDKs — verified state as of 2026-09-02

### 1.1 Graph API version timeline

| Version | Released | Available until |
|---|---|---|
| **v26.0** | 2026-07-29 | TBD |
| v25.0 | 2026-02-18 | 2028-07-29 |
| v24.0 | 2025-10-08 | 2028-02-18 |
| v23.0 | 2025-05-29 | 2027-10-08 |
| v22.0 | 2025-01-21 | 2027-05-20 |
| v21.0 | 2024-10-02 | 2027-01-21 |
| v20.0 | 2024-05-21 | **2026-09-24 — expires in 22 days** |

Source: <https://developers.facebook.com/docs/graph-api/changelog/>

Cadence is roughly **two releases per year** (Feb and Jul/Oct), with a **~2-year support window**. Budget one forced upgrade every ~12 months minimum; the version you pin today dies in about two years, silently, by starting to serve `error code 2635` ("deprecated API version").

### 1.2 `facebook-business` (Python) — healthy

```
26.0.1  2026-08-25   <- latest
26.0.0  2026-08-06
25.0.3  2026-07-17
25.0.2  2026-06-08
25.0.1  2026-03-30
25.0.0  2026-03-10
24.0.1  2025-11-20
24.0.0  2025-10-24
23.0.3  2025-10-14
```
Source: <https://pypi.org/pypi/facebook-business/json> (release upload timestamps).

`facebook_business/apiconfig.py` pins:
```python
ads_api_config = {
  'API_VERSION': 'v26.0',
  'SDK_VERSION': 'v26.0.1',
}
```
Source: <https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/apiconfig.py>

**Lag from Graph API release to SDK release: 8 days** (v26.0 shipped 2026-07-29, SDK 26.0.0 on 2026-08-06). That is genuinely good tracking.

`requires_python` is **null** in the package metadata — the wheel declares no Python version floor, so pip will happily install it into a runtime it was never tested on. Pin and test yourself.

### 1.3 `facebook-nodejs-business-sdk` — **do not use**

This is the single most load-bearing finding for stack choice.

```
npm dist-tags: { latest: '24.0.1' }
24.0.1  published 2025-11-21T07:53:28Z   <- newest on npm
24.0.0  published 2025-10-24
23.0.3  published 2025-10-14
```
Source: <https://registry.npmjs.org/facebook-nodejs-business-sdk> (`time` map + `dist-tags`).

Meanwhile the **git repo is current**:
```js
// src/api.js  (main branch)
static get VERSION(): string { return 'v26.0'; }
static get SDK_VERSION(): string { return '26.0.1'; }
```
and `package.json` on `main` says `"version": "26.0.1"`.
Sources: <https://raw.githubusercontent.com/facebook/facebook-nodejs-business-sdk/main/src/api.js>, <https://raw.githubusercontent.com/facebook/facebook-nodejs-business-sdk/main/package.json>

**So: the code is maintained, but the npm publish pipeline has been broken or abandoned for ~9.5 months.** `npm i facebook-nodejs-business-sdk` in September 2026 gets you a client hard-coded to **v24.0** — two Graph API versions and ~10 months of ad-product changes behind. Anything added in v25/v26 (fields, enums, edges) is simply absent from the typed surface, and the pinned `VERSION` means every request silently goes to the old version unless you override it.

Other Node SDK smells, from the published tarball metadata:
- Built with **Node 12.22.12 / npm 6.14.16** — a 2022-era toolchain.
- Runtime deps include `mixwith@~0.1.1` (a mixin library last meaningfully touched years ago), `currency-codes`, `iso-3166-1`, `email-validator` — an ads client that pulls in an email validator is carrying the Conversions API along for the ride.
- Flow-typed source (`static get VERSION(): string`) compiled to ES5 UMD; the shipped `.d.ts` surface is thin.

Even at its best, the Node SDK's ergonomics are poor: it is a mechanical port of the Python codegen (`new AdAccount(id).createCampaign(fields, params)`), it does not model the response envelope, and its error type does not expose `error_subcode` cleanly.

### 1.4 Recommendation: hand-roll the HTTP client, vendor the SDK as a spec

**Build a thin typed client. Use the Python SDK's generated `adobjects/*.py` as your schema source of truth.**

Why hand-rolling wins for *this* system specifically:

1. **You need the response headers, and the SDKs bury them.** Every rate-limit decision depends on `x-business-use-case-usage`, `x-app-usage`, `x-ad-account-usage` and `x-fb-ads-insights-throttle`. Airbyte had to *subclass* `FacebookAdsApi` (`class MyFacebookAdsApi(FacebookAdsApi)`) purely to intercept responses and read those headers — see <https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-facebook-marketing/source_facebook_marketing/api.py>. If the first thing every serious consumer does is subclass around the SDK, the SDK is not buying you much.

2. **The SDK's type checker is not a type system.** `TypeChecker(param_types, enums)` validates at runtime against a dict of stringly-typed names. It gives you no compile-time safety and no IDE completion in TS. A hand-rolled TS client with `zod`/`typebox` schemas generated from the SDK's enums gives you both.

3. **Version pinning is a first-class concern and the SDK makes it global.** `FacebookAdsApi.API_VERSION` is a class-level constant. You want per-tenant / per-call-site version pinning during a migration ("read insights on v25, publish on v26 for these 20 accounts"). That is a one-line config in a hand-rolled client and a fight with the SDK.

4. **The SDK's helper semantics can hurt you.** Concrete example: `VideoUploadSession.__init__(self, video, wait_for_encoding=False, interval=3, timeout=180)` — the built-in encode wait gives up after **180 seconds** and raises `FacebookError('video encoding timeout: 180')`. For AI-generated video that is often fine, but for larger masters it is a coin flip, and the failure is indistinguishable from a real error. You want that poll under your orchestrator's control, not inside a `time.sleep` loop.
   Source: <https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/video_uploader.py>

**What to actually do:**

- Write `scripts/gen-meta-types.ts` that fetches the pinned tag of `facebook-python-business-sdk` and regex-extracts every `class Field(AbstractObject.Field)` and every nested enum class into TS union types and const objects. This is ~150 lines and gives you `type CampaignObjective = 'OUTCOME_SALES' | ...` derived from Meta's own spec.
- Keep `facebook-business` (Python) installed in a *scratch* container as an oracle: when a request fails mysteriously, replay it with the SDK to see whether the SDK's param checker rejects it.
- Hand-roll: auth/token injection, version pin, retry classification, rate-limit accounting, structured error mapping, batch envelope handling, resumable upload.

**Counter-case (when to just use the Python SDK):** if the team is Python-only and the platform is single-tenant/low-volume, `facebook-business` is fine and saves a week. The moment you have >1 advertiser and need per-account rate budgets, you will subclass it, and at that point you have hand-rolled the interesting half anyway.

---

## 2. The Graph API surface you actually need

All enum lists below are extracted from the v26.0.1 SDK codegen unless noted.

### 2.1 Object graph and endpoints

```
POST /v26.0/act_{AD_ACCOUNT_ID}/campaigns      -> Campaign
POST /v26.0/act_{AD_ACCOUNT_ID}/adsets         -> AdSet
POST /v26.0/act_{AD_ACCOUNT_ID}/adimages       -> AdImage      (returns content hash)
POST /v26.0/act_{AD_ACCOUNT_ID}/advideos       -> AdVideo       (chunked; graph-video host)
POST /v26.0/act_{AD_ACCOUNT_ID}/adcreatives    -> AdCreative
POST /v26.0/act_{AD_ACCOUNT_ID}/ads            -> Ad
POST /v26.0/act_{AD_ACCOUNT_ID}/asyncadrequestsets -> AdAsyncRequestSet (bulk, <=1000)
GET  /v26.0/{OBJECT_ID}/insights                (sync)
POST /v26.0/{OBJECT_ID}/insights                -> { report_run_id } (async)
GET  /v26.0/act_{AD_ACCOUNT_ID}/campaignsbylabels?ad_label_ids=[...]&operator=ALL
GET  /v26.0/act_{AD_ACCOUNT_ID}/adsetsbylabels
GET  /v26.0/act_{AD_ACCOUNT_ID}/adsbylabels
GET  /v26.0/act_{AD_ACCOUNT_ID}/adrules_library -> AdRule (Meta's server-side automated rules)
```

### 2.2 Campaign creation

Required: `name`, `objective`, `special_ad_categories`.
Source: <https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns/>

`objective` (21 values, SDK `Campaign.Objective`) — note the legacy set is still enumerated but the ODAX `OUTCOME_*` family is what new accounts get:
```
APP_INSTALLS, BRAND_AWARENESS, CONVERSIONS, EVENT_RESPONSES, LEAD_GENERATION,
LINK_CLICKS, LOCAL_AWARENESS, MESSAGES, OFFER_CLAIMS, OUTCOME_APP_PROMOTION,
OUTCOME_AWARENESS, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES,
OUTCOME_TRAFFIC, PAGE_LIKES, POST_ENGAGEMENT, PRODUCT_CATALOG_SALES, REACH,
STORE_VISITS, VIDEO_VIEWS
```

`special_ad_categories` (7): `CREDIT, EMPLOYMENT, FINANCIAL_PRODUCTS_SERVICES, HOUSING, ISSUES_ELECTIONS_POLITICS, NONE, ONLINE_GAMBLING_AND_GAMING`

`bid_strategy` (4, identical on Campaign and AdSet): `COST_CAP, LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, LOWEST_COST_WITH_MIN_ROAS`

`status` on create accepts only `ACTIVE` / `PAUSED`. But `Campaign.EffectiveStatus` is a **6-value** superset you must handle on read: `ACTIVE, ARCHIVED, DELETED, IN_PROCESS, PAUSED, WITH_ISSUES`. `IN_PROCESS` is the one that bites — the object exists but is not yet materialised; treating it as a failure causes double-creates.

`spend_cap` minimum is **$100 USD equivalent**. `execution_options` accepts `validate_only` and `include_recommendations` — see §7 (dry-run).

### 2.3 Ad set creation

Required: `name`, `campaign_id`, `targeting` (with `countries`), `status`, plus exactly one of `daily_budget` / `lifetime_budget`. `lifetime_budget` requires `end_time`.
Source: <https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/>

`billing_event` (11): `APP_INSTALLS, CLICKS, IMPRESSIONS, LINK_CLICKS, LISTING_INTERACTION, NONE, OFFER_CLAIMS, PAGE_LIKES, POST_ENGAGEMENT, PURCHASE, THRUPLAY`

`optimization_goal` (33): `ADVERTISER_SILOED_VALUE, AD_RECALL_LIFT, APP_INSTALLS, APP_INSTALLS_AND_OFFSITE_CONVERSIONS, AUTOMATIC_OBJECTIVE, CONVERSATIONS, DERIVED_EVENTS, ENGAGED_PAGE_VIEWS, ENGAGED_USERS, EVENT_RESPONSES, IMPRESSIONS, IN_APP_VALUE, LANDING_PAGE_VIEWS, LEAD_GENERATION, LINK_CLICKS, MEANINGFUL_CALL_ATTEMPT, MESSAGING_APPOINTMENT_CONVERSION, MESSAGING_DEEP_CONVERSATION_AND_FOLLOW, MESSAGING_PURCHASE_CONVERSION, NONE, OFFSITE_CONVERSIONS, PAGE_LIKES, POST_ENGAGEMENT, PROFILE_AND_PAGE_ENGAGEMENT, PROFILE_VISIT, QUALITY_CALL, QUALITY_LEAD, REACH, REMINDERS_SET, SUBSCRIBERS, THRUPLAY, VALUE, VISIT_INSTAGRAM_PROFILE`

`destination_type` (23) includes `WEBSITE, APP, MESSENGER, WHATSAPP, INSTAGRAM_DIRECT, SHOP_AUTOMATIC, IMAGINE, ON_VIDEO, INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE, ...`

Minimum budgets (docs, `LOWEST_COST_WITHOUT_CAP`): **$0.50/day** for impression-billed, **$2.50/day** for clicks/likes/video views, **$40/day** for low-frequency actions. "Amounts double for certain countries including US, UK, Australia, and Japan."

**Do not hardcode these.** `AdAccount` exposes readable `min_daily_budget` (unsigned int, account currency minor units) and `min_campaign_group_spend_cap`. Read them once per account at onboarding and cache. Source: SDK `adaccount.py` Field list.

**EU DSA fields:** `AdSet.dsa_beneficiary` and `AdSet.dsa_payor` (both `string`), with account-level defaults at `AdAccount.default_dsa_beneficiary` / `default_dsa_payor`. If you target EU countries without these populated, delivery is blocked. Verified present in v26.0.1 SDK codegen (`adset.py` lines 66-67, 451-452; `adaccount.py` 57-58).

### 2.4 Video upload — the chunked flow, exactly

Uploads go to a **different host**: `https://graph-video.facebook.com` (SDK `VideoUploadRequest.send()` passes `url_override='https://graph-video.facebook.com'`). Hitting `graph.facebook.com` with a large multipart body will appear to work and then fail oddly.

Three-phase `upload_phase` on `POST /act_{id}/advideos`:

```
1. upload_phase=start&file_size={bytes}
   -> { "video_id", "upload_session_id", "start_offset", "end_offset" }

2. upload_phase=transfer&upload_session_id={sid}&start_offset={n}
   multipart file field: video_file_chunk
   -> { "start_offset", "end_offset" }        # loop until start_offset == end_offset
   # NOTE: on error, the next offsets may come back inside
   #   body['error']['error_data']['start_offset'] / ['end_offset']
   #   -- you MUST read them from there to resume. The SDK does exactly this.

3. upload_phase=finish&upload_session_id={sid}&file_name={name}
   -> { "success": true }
```
Source: SDK `video_uploader.py` (`getParamsFromContext` for each phase; the `error_data` offset recovery is at lines ~225-231).

Other accepted params on `POST /advideos` (SDK `AdAccount.create_ad_video` param_types): `file_url` (Meta pulls from your URL — see §5), `title`, `name`, `description`, `thumb` (file), `source` (file), `is_ai_generated` (**bool**), `is_boost_intended`, `replace_video_id`, `slideshow_spec` (map), `container_type`, `unpublished_content_type`, `chunk_session_id`, `fbuploader_video_file_chunk`.

> `is_ai_generated: bool` exists as a create parameter on `POST /act_{id}/advideos` in v26.0.1 codegen. For a platform whose entire creative pipeline is generative, set it. The exact downstream policy consequence is **UNVERIFIED** (see §12).

**Readiness polling — the exact contract:**

```
GET /v26.0/{video_id}?fields=status
-> { "status": { "video_status": "processing" | "ready" | <error state> } }
```
The SDK's `VideoEncodingStatusChecker.waitUntilReady` loops while `status['video_status'] == 'processing'`, then raises unless it equals `'ready'`. This is authoritative even though the public HTML reference for the Video node does not document the `status` sub-object.
Source: <https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/video_uploader.py>

**A creative referencing a video that is still `processing` will fail or produce a broken ad.** Poll to `ready` before `POST /adcreatives`. This is a mandatory durable-wait step in the pipeline.

**Resumable Upload API (the *other* upload path)** — different, newer, and used for some ad surfaces:
```
POST /v26.0/{APP_ID}/uploads?file_name=&file_length=&file_type=&access_token=
  -> { "id": "upload:{SESSION_ID}" }
POST /v26.0/upload:{SESSION_ID}
  Authorization: OAuth {TOKEN}
  file_offset: 0
  <binary body>
  -> { "h": "2:c2FtcGxl..." }          # file handle
GET  /v26.0/upload:{SESSION_ID}         -> { "file_offset": "..." }   # to resume
```
`file_type` accepts only `application/pdf, image/jpeg, image/jpg, image/png, video/mp4`. Note `Authorization: OAuth <token>` — not `Bearer`.
Source: <https://developers.facebook.com/docs/graph-api/guides/upload>

### 2.5 Images are content-addressed by Meta

`POST /act_{id}/adimages` returns an `AdImage` whose fields include `hash`, `url`, `url_128`, `permalink_url`, `width`, `height`, `original_width`, `original_height`, `creatives`, `is_associated_creatives_in_adgroups`. Source: SDK `adimage.py`.

The `hash` is what you put in `object_story_spec.video_data.image_hash`. Re-uploading identical bytes yields the same hash, so Meta does your image dedupe for you — but **you should still cache `sha256(bytes) -> meta_image_hash` locally per ad account**, because the hash is scoped to the ad account and a round-trip upload is a Class-A operation plus a rate-limit unit.

### 2.6 AdCreative

81 fields. The ones that matter for a generative pipeline:

`object_story_spec` for a video ad:
```json
{
  "page_id": "<PAGE_ID>",
  "instagram_user_id": "<IG_USER_ID>",
  "video_data": {
    "video_id": "<VIDEO_ID>",
    "image_hash": "<THUMB_HASH>",
    "message": "<primary text>",
    "title": "<headline>",
    "link_description": "<description>",
    "call_to_action": {
      "type": "SHOP_NOW",
      "value": { "link": "https://example.com/offer" }
    }
  }
}
```
Instagram placement requires `instagram_user_id` on the creative. Source: <https://developers.facebook.com/docs/marketing-api/reference/ad-creative/>

`call_to_action.type` has **102** values in v26.0.1. The workhorses: `SHOP_NOW, LEARN_MORE, SIGN_UP, BOOK_NOW, GET_OFFER, GET_QUOTE, SUBSCRIBE, DOWNLOAD, ORDER_NOW, CONTACT_US, APPLY_NOW, GET_STARTED, WATCH_MORE, SEE_MORE, NO_BUTTON`. New/AI-flavoured ones present: `SHOP_WITH_AI`, `TRY_ON_WITH_AI`, `BOOK_A_CONSULTATION`, `ASK_ABOUT_SERVICES`.

Generative-relevant fields on AdCreative: `asset_feed_spec` (multi-asset / Advantage+ creative), `degrees_of_freedom_spec` (which automatic transformations Meta may apply), `generative_asset_spec`, `creative_sourcing_spec`, `media_sourcing_spec`, `contextual_multi_ads`, `format_transformation_spec`.

**`authorization_category` (3 values): `NONE, POLITICAL, POLITICAL_WITH_DIGITALLY_CREATED_MEDIA`.** The third value is Meta's disclosure category for AI-generated media in social/political/election ads. If your platform can be pointed at an `ISSUES_ELECTIONS_POLITICS` campaign, this field is the compliance hook and must be set. Source: SDK `adcreative.py`.

### 2.7 Ad creation — the state machine you must model

`POST /act_{id}/ads` params (SDK `AdAccount.create_ad`): `name`, `adset_id`, `creative` (AdCreative or `{"creative_id": "..."}`), `status`, `conversion_domain`, `adlabels`, `tracking_specs`, `bid_amount`, `execution_options`, `creative_asset_groups_spec`, `creative_automation_spec`, `source_ad_id`, `draft_adgroup_id`, `dataset_split_specs`, `priority`, `ad_schedule_start_time`/`ad_schedule_end_time`.

**`Ad.ExecutionOptions` = `include_recommendations, synchronous_ad_review, validate_only`.**

`synchronous_ad_review` is the single most useful undocumented-in-HTML flag for an autonomous system: it makes ad review run inline with the create call, so you get `DISAPPROVED` in the response instead of discovering it minutes later via polling. Use it on every publish. Source: SDK `ad.py` `class ExecutionOptions`.

`Ad.EffectiveStatus` (12) — this is the real publish state machine:
```
ACTIVE, ADSET_PAUSED, ARCHIVED, CAMPAIGN_PAUSED, DELETED, DISAPPROVED,
IN_PROCESS, PAUSED, PENDING_BILLING_INFO, PENDING_REVIEW, PREAPPROVED, WITH_ISSUES
```
`PENDING_BILLING_INFO` is the one that will strand an autonomous pipeline silently: nothing is wrong with your ad, the advertiser's card failed.

Read-side fields for autonomous remediation: `ad_review_feedback`, `issues_info`, `failed_delivery_checks`, `recommendations`, `preview_shareable_link` (hand this to a human when you escalate), `ad_active_time`.

### 2.8 Insights

**Sync:** `GET /{object_id}/insights` on `/act_{id}`, `/{campaign_id}`, `/{adset_id}`, `/{ad_id}`. Default returns basic metrics for the past 30 days.

**Async (use this for anything non-trivial):**
```
POST /{object_id}/insights            -> { "report_run_id": "..." }
GET  /{report_run_id}                 -> { async_status, async_percent_completion }
GET  /{report_run_id}/insights        -> paged results
```
`async_status` values: `Job Not Started`, `Job Started`, `Job Running`, `Job Completed`, `Job Failed`, `Job Skipped`. Poll until `Job Completed` **and** `async_percent_completion == 100`.
- `Job Skipped` = the job "expired after inactivity; resubmit required" — a distinct, retryable outcome, not a failure.
- "Do not store the `report_run_id` for long term use, it expires after **30 days**."
- "it can take up to an hour to complete a request including retry attempts."
Source: <https://developers.facebook.com/docs/marketing-api/insights/best-practices>

**221 readable fields** in `AdsInsights.Field`. Beyond the obvious (`spend, impressions, clicks, ctr, cpc, cpm, reach, frequency, actions, action_values, purchase_roas, cost_per_action_type, video_thruplay_watched_actions, video_p25/50/75/95/100_watched_actions`), the ones that matter for a *self-improving* system:

- `quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking` — Meta's own relative diagnostics.
- **`creative_fatigue_summary`, `creative_fatigued_ads`, `creative_diversity_score`, `creative_diversity_data`, `creative_diversity_label`** — Meta now surfaces fatigue and diversity directly. Do not rebuild a fatigue detector before reading these.
- `opportunity_score_l4` (also `AdAccount.opportunity_score`, `opportunity_score_weight`).
- `attribution_setting` and `anchor_event_attribution_setting`, `multi_event_conversion_attribution_setting` — **store these alongside every metric row** (§4.4).
- `video_play_curve_actions`, `video_play_retention_0_to_15s_actions`, `video_play_retention_graph_actions` — per-second retention curves. This is your creative-level learning signal: which second people drop at.
- `auction_bid`, `auction_competitiveness`, `auction_max_competitor_bid`, `wish_bid`.

**`action_attribution_windows`** (26 values, SDK `AdsInsights.ActionAttributionWindows`):
```
1d_click, 1d_ev, 1d_sequenced, 1d_view, 7d_click, 7d_sequenced, 7d_view,
7d_view_all_conversions, 7d_view_first_conversion, 28d_click, 28d_sequenced,
28d_view, 28d_view_all_conversions, 28d_view_first_conversion,
custom, dda, default, incrementality, incrementality_all_conversions,
incrementality_first_conversion, skan_click, skan_click_second_postback,
skan_click_third_postback, skan_view, skan_view_second_postback, skan_view_third_postback
```
`use_unified_attribution_setting` (bool) makes the response use the ad set's configured attribution setting instead of your explicit windows. **Pick one convention and never mix them in the same table.**

**`breakdowns`** — 93 values. Beyond `age, gender, country, region, dma, publisher_platform, platform_position, impression_device, device_platform, product_id, hourly_stats_aggregated_by_advertiser_time_zone`, note these creative-analytics breakdowns, which are exactly what a generative system wants:
```
ad_format_asset, body_asset, call_to_action_asset, description_asset, image_asset,
link_url_asset, title_asset, video_asset,
creative_automation_asset_id, creative_relaxation_asset_type,
flexible_format_asset_type, gen_ai_asset_type,
media_type, media_format, media_text_content, media_asset_url,
reels_trending_topic, landing_destination
```
`gen_ai_asset_type` is a first-class breakdown in v26.0 — Meta already segments AI-generated assets in reporting.

`action_breakdowns` (16): `action_type, action_target_id, action_destination, action_device, action_reaction, action_video_sound, action_video_type, action_carousel_card_id, action_carousel_card_name, action_canvas_component_name, conversion_destination, is_business_ai_assisted, matched_persona_id, matched_persona_name, signal_source_bucket, standard_event_content_type`

`date_preset` (20): `today, yesterday, this_week_mon_today, this_week_sun_today, last_week_mon_sun, last_week_sun_sat, this_month, last_month, this_quarter, last_quarter, this_year, last_year, last_3d, last_7d, last_14d, last_28d, last_30d, last_90d, maximum, data_maximum`

`level` (4): `account, ad, adset, campaign`

**37-month hard lookback.** "Insight tables are only able to pull data from the last 37 months." Source: <https://docs.airbyte.com/integrations/sources/facebook-marketing>

### 2.9 Batch and async bulk

**Batch** (`POST /` with `batch=[...]`): max **50 requests**, each counting individually against rate limits. Fields per entry: `method`, `relative_url`, `body` (URL-query-encoded), `name`, `attached_files`. Cross-references via `{result=<name>:$.data.*.id}`. **Not atomic** — partial failure leaves partial state. Documented Marketing API restriction: you cannot batch multiple ad sets under the same campaign.
Source: <https://developers.facebook.com/docs/graph-api/batch-requests>

**Gotcha:** batch sub-responses each carry their own `headers` array, and the rate-limit headers live there, not on the outer HTTP response. Airbyte's `_get_max_usage_pause_interval_from_batch` iterates records, lowercases `record["headers"]` into a dict, and takes the max usage across sub-responses. If you only read the outer response headers on a batch call, you fly blind into a throttle.

**Async bulk ad creation:** `POST /act_{id}/asyncadrequestsets` with `name`, `notification_mode` (`OFF` | `ON_COMPLETE`), `notification_uri`, `ad_specs`. Max **1000 requests per set**; per-request status `initial | in_progress | success | error | canceled`; set-level `success_count`, `error_count`, `is_completed`, `result`.
Source: <https://developers.facebook.com/docs/marketing-api/asyncrequests/>

### 2.10 Meta's own rules engine (borrow, don't rebuild)

`GET/POST /act_{id}/adrules_library` → `AdRule { id, name, account_id, evaluation_spec, execution_spec, schedule_spec, status, disable_error_code, created_by, created_time, updated_time, ui_creation_source }`, plus `GET /act_{id}/adrules_history`. `AdRule.Status`: `ENABLED, DISABLED, DELETED, HAS_ISSUES`.

For simple guardrails ("pause any ad whose CPA exceeds 2× target over 3 days"), pushing an AdRule to Meta is strictly better than polling insights yourself: it runs server-side on Meta's data at Meta's freshness, costs no API quota, and survives your platform being down. Reserve your own loop for decisions that need cross-account or cross-creative reasoning.

---

## 3. Rate limits and the API client

### 3.1 The quota formulas (per ad account, per hour)

| Bucket | Development tier | Standard/Full access |
|---|---|---|
| **ads_management** | `300 + 40 × active ads` | `100,000 + 40 × active ads` |
| **ads_insights** | `600 + 400 × active ads − 0.001 × user_errors` | `190,000 + 400 × active ads − 0.001 × user_errors` |
| **custom_audience** | `5,000 + 40 × active CAs` (cap 700,000) | `190,000 + 40 × active CAs` (cap 700,000) |
| App-level (Graph) | `200 × number of users` per hour | same |

Sources: <https://developers.facebook.com/docs/graph-api/overview/rate-limiting>, <https://developers.facebook.com/docs/marketing-api/overview/rate-limiting>

Two things to internalise:

1. **`− 0.001 × user_errors` is real.** Your ads_insights quota is *reduced by your own 4xx rate*. A buggy retry loop that hammers a bad param does not just waste calls, it shrinks the budget. Treat non-retryable errors as a monitored SLO.
2. **Quota scales with active ads.** A brand-new advertiser with 0 active ads has `100,000` calls/hr on full access but only `300` on dev tier. Your onboarding flow for a new tenant is the tightest window you will ever operate in.

**Separate, independent QPS limit:** "100 requests per second (QPS) per app and ad account combination" for create/edit on campaigns, ad sets, ads. Breaching it returns **`613` subcode `5044001`**. This is a *mutation* limit and is not visible in the hourly BUC headers — you need your own token bucket for it.

There is also a legacy score system on the ad-account limiter: reads = 1 point, writes = 3 points; dev tier max score 60, decay 300s, block 300s; standard tier max score 9000, decay 300s, block 60s.

### 3.2 Headers — exact names and shapes

```
X-App-Usage:
  {"call_count": 12, "total_cputime": 4, "total_time": 7}          # each 0-100 (%)

X-Business-Use-Case-Usage:
  {"<business_id>": [
     {"type": "ads_management",           # or ads_insights, custom_audience,
                                          #    instagram, leadgen, messenger, pages
      "call_count": 33,
      "total_cputime": 12,
      "total_time": 15,
      "estimated_time_to_regain_access": 0,   # MINUTES
      "ads_api_access_tier": "standard_access" # or development_access
     }]}

X-Ad-Account-Usage:                       # Ads API v3.3 and older
  {"acc_id_util_pct": 9.67, "reset_time_duration": 100,
   "ads_api_access_tier": "standard_access"}

X-FB-Ads-Insights-Throttle:               # on /insights responses
  {"app_id_util_pct": 0.0, "acc_id_util_pct": 0.0,
   "ads_api_access_tier": "standard_access"}
```

`estimated_time_to_regain_access` is in **minutes**, and every other number is a **percentage 0-100**. Mixing those units is a classic day-loser.

### 3.3 Error codes

| Code | Subcode | Meaning | Retry? |
|---|---|---|---|
| 1 | — | API Unknown; "possibly a temporary issue due to downtime" | Yes, backoff |
| 1 | 99 | Wrong `level` param (e.g. `adset` where `campaign` expected) | **No** |
| 2 | — | API Service; "temporary issue due to downtime" | Yes |
| 4 | — | Application request limit reached | Yes, long backoff |
| 17 | 2446079 | User request limit reached | Yes, long backoff |
| 32 | — | Page API user/app token rate limit | Yes |
| 100 | many | Invalid parameter | **No** |
| 190 | — | Invalid OAuth token — expired/revoked | **No** — re-auth tenant |
| 200 | 1870034 | Permission error / Custom Audience TOS not accepted | **No** |
| 294 | — | Missing `ads_management` permission or not allowlisted | **No** |
| 341 | — | Application limit reached | Yes |
| 368 | — | Policy violation / temporarily blocked | Yes (docs say "wait and retry") |
| 506 | — | Duplicate post — "cannot be published consecutively" | **No** — see §4 |
| 613 | 1487742 | "Too many calls from this ad-account" | Yes |
| 613 | 5044001 | QPS mutation limit exceeded | Yes, short backoff |
| 960 | — | Batch error (Airbyte's `FACEBOOK_BATCH_ERROR_CODE`) | Yes |
| 2635 | — | Deprecated API version | **No** — deploy |
| 80000 | 2446079 | BUC: ads_insights limit | Yes |
| 80003 | 2446079 | BUC: custom_audience | Yes |
| 80004 | 2446079 | BUC: ads_management | Yes |
| 80008 | — | BUC: v3.3 Ads API (non-insights) | Yes |

Sources: <https://developers.facebook.com/docs/graph-api/overview/rate-limiting>, <https://developers.facebook.com/docs/graph-api/guides/error-handling>, <https://developers.facebook.com/docs/marketing-api/error-reference/>

Error envelope:
```json
{"error": {"message": "...", "type": "OAuthException", "code": 190,
           "error_subcode": 460, "error_user_title": "...", "error_user_msg": "...",
           "fbtrace_id": "A1b2C3..."}}
```
The public error-handling doc does **not** list `is_transient`, but the Python SDK explicitly parses it (`if 'is_transient' in self._error: self._api_transient_error = self._error['is_transient']`, `facebook_business/exceptions.py`). So Meta does return it on some responses. **Treat `is_transient: true` as an override that makes anything retryable; do not treat its absence as `false`.**

Always log `fbtrace_id`. It is the only handle Meta support will act on.

Airbyte's production retry set — worth copying verbatim as a starting classification:
```python
FACEBOOK_RATE_LIMIT_ERROR_CODES = {4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008}
FACEBOOK_TEMPORARY_OAUTH_ERROR_CODE = 2
FACEBOOK_BATCH_ERROR_CODE = 960
FACEBOOK_UNKNOWN_ERROR_CODE = 99
FACEBOOK_CONNECTION_RESET_ERROR_CODE = 104
```
Source: <https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-facebook-marketing/source_facebook_marketing/streams/common.py>

Also from Airbyte: when the response says **"Please reduce the amount of data you're asking for, then retry your request"** (or the generic "An unknown error occurred"), the fix is to *halve the page size / narrow the date window*, not to back off — Airbyte narrows down to single-day intervals. Encode this as a distinct `SHRINK_AND_RETRY` outcome, separate from `BACKOFF`.

### 3.4 The client design

```
Per-(app, ad_account) token bucket:
  - mutations: 100 QPS   (hard, from docs; not in headers)
  - reads:     shaped by BUC headers

Governor loop (per ad account), Airbyte-proven thresholds:
  usage = max(x_app_usage.{call_count,total_time,total_cputime},
              x_ad_account_usage.acc_id_util_pct,
              max over x_business_use_case_usage[*] of
                {call_count, total_cputime, total_time})
  pause = max over BUC entries of estimated_time_to_regain_access (minutes)

  MIN_RATE = 85  -> sleep max(2 min,  pause)
  MAX_RATE = 95  -> sleep max(10 min, pause)
```
Source for the constants: `MAX_RATE, MAX_PAUSE_INTERVAL = (95, timedelta(minutes=10))`, `MIN_RATE, MIN_PAUSE_INTERVAL = (85, timedelta(minutes=2))` in Airbyte's `MyFacebookAdsApi`.

Implementation notes:
- Keep the bucket state in **Redis**, keyed `rl:{ad_account_id}:{bucket}`, so all workers share one view. A per-process limiter is useless when 20 Temporal workers hit one account.
- **Never sleep inside a Temporal activity for 10 minutes.** Instead: the activity raises a typed `RateLimited(retry_after_seconds)`; the workflow does `sleep(retry_after)` and re-invokes. That keeps the wait off the worker's activity slot and visible in the workflow history.
- Feed the `x-fb-ads-insights-throttle` `acc_id_util_pct` into a semaphore that caps *concurrent async insight jobs per account*. Airbyte tracks this precisely because too many concurrent report runs is the fastest way to get insights throttled.
- Class your traffic: `PUBLISH` (mutations, tiny volume, latency-sensitive) vs `MEASURE` (insights, huge volume, latency-tolerant). Give `PUBLISH` a reserved slice of the account budget so a reporting backfill can never block a campaign launch.

---

## 4. Idempotency for money-spending operations

**The Graph API has no idempotency key.** There is no `Idempotency-Key` header, no client-supplied request id, no dedupe token. The only duplicate-prevention primitive documented anywhere is error `506` ("Duplicate posts cannot be published consecutively"), which is a content heuristic on Page posts, not a guarantee.

Therefore you must build a three-layer scheme. All three are required; any one alone leaks.

### Layer 1 — Deterministic intent identity (your side)

Compute an idempotency key **from the intent, not from the attempt**:

```
idem = sha256(
  tenant_id | ad_account_id | pipeline_version |
  canonical_json({objective, budget, targeting, creative_render_id, schedule, ...})
)[:32]
```

Persist an **intent ledger** row *before* any network call, in the same transaction as the decision that produced it:

```sql
CREATE TABLE publish_intent (
  idem_key        text PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  ad_account_id   text NOT NULL,
  object_kind     text NOT NULL,   -- campaign|adset|ad|creative|video
  request_body    jsonb NOT NULL,
  state           text NOT NULL,   -- PENDING|IN_FLIGHT|CONFIRMED|ABANDONED
  meta_object_id  text,            -- set exactly once
  attempts        int  NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  confirmed_at    timestamptz,
  fbtrace_ids     text[] NOT NULL DEFAULT '{}'
);
```

The dangerous window is: request sent → Meta created the object → response lost (timeout, worker OOM, 502 from an edge). Layer 1 tells you an attempt *may* have landed. Layer 2 tells you whether it did.

### Layer 2 — Meta-side reconciliation via AdLabels

Attach the idempotency key as an **AdLabel** on every created object, then query by label to find out what actually exists.

```
POST /act_{id}/adlabels           { "name": "idem:<idem_key>" }   -> { id }
POST /act_{id}/campaigns          { ..., "adlabels": [{"id": "<label_id>"}] }

# recovery:
GET /act_{id}/campaignsbylabels?ad_label_ids=["<label_id>"]&operator=ALL
GET /act_{id}/adsetsbylabels?ad_label_ids=[...]&operator=ALL
GET /act_{id}/adsbylabels?ad_label_ids=[...]&operator=ALL
```
Edge paths and params verified in SDK codegen: `endpoint='/campaignsbylabels'`, `endpoint='/adsetsbylabels'`, `endpoint='/adsbylabels'`, each with `param_types = {'ad_label_ids': 'list<string>', 'operator': 'operator_enum'}` and `Operator ∈ {ALL, ANY}`. Source: `facebook_business/adobjects/adaccount.py`.

This is materially better than name-matching because:
- Labels are a first-class filterable edge; `name` is not a documented filter on `GET /act_{id}/campaigns` (the SDK's param_types for that edge are only `date_preset`, `effective_status`, `is_completed`, `time_range`).
- Labels survive renames, which an autonomous system will do.
- Labels can be attached to *all three* levels, giving one query per level to reconstruct a partially-created tree.

**Recovery algorithm on any retry:**
```
1. Read intent row. If CONFIRMED -> return meta_object_id. Done.
2. If IN_FLIGHT or attempts > 0:
     query <kind>bylabels for idem label
     if exactly 1 result -> CONFIRM with that id, return
     if >1 results       -> ALARM (double-create already happened);
                            keep lowest id, archive the rest, page a human
     if 0 results        -> safe to (re)issue the create
3. Mark IN_FLIGHT, attempts += 1, issue create with adlabels attached
4. On success -> CONFIRMED. On network-ambiguous failure -> leave IN_FLIGHT, let retry hit step 2.
```

The label creation itself must be idempotent: `GET /act_{id}/adlabels` and match on name before creating, or accept that duplicate labels with the same name are harmless (query by the label *id* you stored, not by name).

**Cost:** one extra POST per object tree (the label), plus one GET per level on recovery only. Negligible against a 100k/hr budget.

### Layer 3 — Create everything PAUSED, activate last

Structure the pipeline so that the expensive/irreversible step is *one* small mutation:

```
create campaign  status=PAUSED
create adset     status=PAUSED
upload video, poll ready
create creative
create ad        status=PAUSED, execution_options=['synchronous_ad_review']
--- verify: effective_status ∈ {PENDING_REVIEW, PREAPPROVED, PAUSED}, no issues_info ---
--- checkpoint: intent tree CONFIRMED ---
POST /{campaign_id}  { "status": "ACTIVE" }     <- the only money-starting call
```

A duplicated PAUSED tree costs $0 and is garbage-collectable. A duplicated ACTIVE tree costs real money. Collapsing all spend risk into a single idempotent status flip on an object whose id you already have is the highest-leverage design decision in this whole document.

Guard the flip with a **per-ad-account spend authority record**:
```sql
CREATE TABLE spend_authority (
  tenant_id uuid, ad_account_id text, period date,
  authorized_daily_minor bigint,   -- what the human approved
  committed_daily_minor  bigint,   -- sum of ACTIVE adset budgets we believe exist
  PRIMARY KEY (tenant_id, ad_account_id, period)
);
```
Before any activation or budget increase: `SELECT ... FOR UPDATE`, check `committed + delta <= authorized`, write, then call Meta. Reconcile `committed` against Meta's actual `daily_budget` sums hourly; a drift alarm here is your last line of defence against a runaway loop (§9).

### Layer 4 — Orchestrator-level dedupe

With Temporal, set the workflow id to the idempotency key:
```ts
await client.workflow.start(publishAdVariant, {
  workflowId: `publish:${idemKey}`,
  workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
  workflowIdConflictPolicy: 'USE_EXISTING',
  args: [...],
});
```
- `WorkflowIdConflictPolicy.USE_EXISTING` — "Returns the existing open Workflow's Run ID without spawning a duplicate."
- `WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY` — "Permits reuse only when the prior Workflow didn't complete successfully."

Together these mean *a successfully completed publish can never be re-run under the same key*, and a concurrent duplicate start is a no-op that returns the in-flight run. Source: <https://docs.temporal.io/workflow-execution/workflowid-runid>

Note the retention caveat: the dedupe holds only within the namespace's retention period (default 30 days on Temporal Cloud). Your Postgres intent ledger is the durable record; Temporal's dedupe is the cheap fast path.

**Inngest equivalent:** function-level `idempotency: 'event.data.idemKey'` (CEL expression) or event-level `id` — both with a hard **24-hour** window. Source: <https://www.inngest.com/docs/guides/handling-idempotency>. 24 hours is too short to be your only dedupe for a pipeline with multi-day waits.

**Restate equivalent:** the standard `Idempotency-Key` header, with responses "persisted for a retention period of one day (24 hours)", configurable. Plus `/restate/attach/{invocationId}` to re-attach to an in-flight invocation. Source: <https://docs.restate.dev/services/invocation>

---

## 5. Durable workflow orchestration

### 5.1 The workload shape

```
generate script/storyboard   (LLM, seconds-minutes, $)
  -> generate video clips     (async job, 2-20 min, $$$, provider polling)
  -> assemble + render        (CPU/GPU minutes, local or job)
  -> upload to Meta           (chunked, minutes, resumable)
  -> poll video ready         (seconds-minutes)
  -> create creative + ad     (seconds)
  -> WAIT 3-14 DAYS           <-- the defining constraint
  -> pull insights            (async report job, up to 1 hour)
  -> decide (scale/kill/iterate)
  -> optionally: human approval gate  (hours-days)
```

Two properties dominate the choice: **multi-day durable sleeps** and **an execution history that survives a deploy**. A third, underrated: **you will change the pipeline weekly while thousands of runs are mid-sleep**, so *versioning of in-flight executions* is a hard requirement, not a nice-to-have.

### 5.2 Comparison

| | Temporal | Inngest | Trigger.dev | Restate | Step Functions | Celery/BullMQ + FSM |
|---|---|---|---|---|---|---|
| Current SDK | `@temporalio/client` **1.23.0**, `temporalio` (py) **1.32.0** | `inngest` **4.18.1** (npm), **0.5.19** (py) | `@trigger.dev/sdk` **4.5.15** | `@restatedev/restate-sdk` **1.17.0**, py **1.0.5** | n/a (AWS) | `bullmq` **6.3.4**, `celery` **5.6.3** |
| Max durable sleep | Unbounded — "workflows can sleep for months" | **1 year** (documented cap) | No documented cap; waits >5s don't bill compute | Unbounded (`ctx.sleep`) | **1 year** (Standard) | You build it (delayed jobs / beat) |
| Sleep costs compute? | No | No — "does not count against your plan's concurrency limit" | No — ">5 seconds does not count towards compute usage"; concurrency slot freed at the 60s checkpoint | No — suspends on serverless | No | Depends (BullMQ delayed jobs are cheap; Celery ETA tasks are not) |
| History/size limit | **51,200 events / 50 MB** (warn at 10,240 / 10 MB) | Not published | Not published | Journal per invocation | **25,000 events**, **256 KiB** per payload | n/a |
| Dedupe on start | `WorkflowIdConflictPolicy=USE_EXISTING` + `ReusePolicy` — strong, retention-scoped | `idempotency` CEL / event `id`, **24 h** | `idempotencyKey` on trigger | `Idempotency-Key` header, **24 h** default | Execution name uniqueness (90 days) | You build it |
| Human-in-loop | Signals + `condition()`; unbounded wait | `step.waitForEvent` | `wait.createToken()` / `wait.forToken()` — purpose-built | Awakeables | `.waitForTaskToken` (Standard only) | You build it |
| Retries/backoff | Per-activity `RetryPolicy` (initial/backoff coeff/max/max attempts/non-retryable error types) | Per-step, configurable | Per-task, configurable | Automatic, configurable | Per-state `Retry`/`Catch` — **each retry is a billed state transition** | Per-queue |
| Versioning in-flight runs | Patching / Worker Versioning — mature, the reason it exists | Function versioning | Deploy versions, runs pinned | Service versions; long invocations pin old deployments | Versions + aliases (1000/machine) | Ad hoc |
| Local test of a 14-day workflow | **Replay + time-skipping test server** — deterministic, seconds | Dev server | Dev server | Dev server | Local mock, weak | n/a |
| Ops burden | High if self-hosted; Cloud removes it | Lowest | Low | Medium (self-host or Cloud) | Zero | Highest |
| Pricing | Cloud: **$50/M actions** (first 5M), sliding to $25/M >100M; active storage **$0.042/GBh**, retained **$0.00105/GBh**; **support minimum: greater of $100/mo or 5% of spend** (Essentials). No free tier. | Free 50k executions/mo; **Pro from $99/mo**, 1M executions; "an execution is a single durable function run **plus each step inside it**" | Free $5 credit; **Hobby $10/mo**, **Pro $50/mo**; compute **$0.0000338/s** on Small-1x (~$0.12/hr) + **$0.25 per 10k runs**; Free 20 / Hobby 50 / Pro 200+ concurrency | OSS self-host free; Cloud priced separately | **$0.000025 per state transition** (4,000/mo free); Express **$1.00/M requests + $0.00001667/GB-s** | Infra cost only |

Pricing sources: <https://docs.temporal.io/cloud/pricing>, <https://www.inngest.com/pricing>, <https://trigger.dev/pricing>, <https://aws.amazon.com/step-functions/pricing/>
Limits sources: <https://docs.temporal.io/workflow-execution/limits>, <https://www.inngest.com/docs/features/inngest-functions/steps-workflows/sleeps>, <https://trigger.dev/docs/wait>, <https://docs.restate.dev/develop/ts/durable-timers>, <https://docs.aws.amazon.com/step-functions/latest/dg/limits-overview.html>

### 5.3 Recommendation: **Temporal**

Reasons, in order of weight for this specific system:

1. **Deploy-safe long sleeps.** You will ship code changes daily while ~10,000 workflows sit in a 7-day `sleep()`. Temporal's patching / Worker Versioning is the only option here that was designed around exactly this problem, and the failure mode of getting it wrong (non-determinism error) is *loud and safe* rather than silently running new logic against old state.

2. **You can test the 14-day workflow in 200 ms.** The time-skipping test environment plus deterministic replay means "what happens if the video generator fails on day 3 and the insights job returns `Job Skipped` on day 10" is a unit test, not a two-week experiment. For a system that spends money on a timer, this is worth more than everything else combined.

3. **The billing model matches a polling-heavy pipeline.** Inngest bills "a single durable function run **plus each step inside it**" as executions; Step Functions bills every retry as a state transition. This pipeline polls a lot (video encode status, async insight jobs, ad review status). At 50 steps/run × 100k runs/month you are at 5M+ billable units on Inngest — comfortably past the Pro tier — whereas the same shape on Temporal is a few million actions at $50/M with storage measured in GB-hours. Do the arithmetic for your own volume, but the *shape* favours Temporal.

4. **Signals give you a real approval gate.** `Promise.race([condition(() => approved), sleep('48h')])` is a first-class, resumable, auditable approval step. Trigger.dev's `wait.forToken()` is arguably nicer ergonomically for exactly this; Temporal's is more general.

5. **Payload discipline is enforced, and that's good.** The 50 MB / 51,200 event ceiling forces you to pass **references** (R2 keys, render ids) between steps rather than blobs. Step Functions' 256 KiB payload cap forces the same thing more harshly. Systems that let you pass a 200 MB video buffer between steps let you build something that falls over at scale.

**The honest costs of choosing Temporal:**
- **No free tier.** Minimum ~$100/month on Temporal Cloud Essentials before you run anything. Self-hosting means running Cassandra/Postgres + history/matching/frontend services — do not do this with a small team.
- Steepest learning curve here. Determinism rules (no `Date.now()`, no `Math.random()`, no direct I/O in workflow code) will bite every new engineer exactly once.
- The mental model of workflow-vs-activity has to be taught.

**When to pick differently:**
- **Inngest** if the team is <3 people and shipping speed dominates: least ceremony, generous free tier, sleeps up to a year, idempotency built in. Accept the 24-hour idempotency window and the per-step billing.
- **Trigger.dev** if human-in-the-loop is the *dominant* feature. `wait.createToken()` / `wait.forToken()` is the cleanest approval primitive of the five, and "tasks can run for as long as you need, with no timeouts" plus checkpointed waits that don't burn concurrency is genuinely well-suited to render jobs.
- **Restate** if you want durable execution *inside* your own services with no separate worker fleet, and you like the RPC-shaped model. Virtual Objects give you per-key serialisation for free — a natural fit for "only one publish at a time per ad account". The 24-hour idempotency retention is configurable.
- **Step Functions** only if you are already deep in AWS and the pipeline is coarse (<20 states). The 25,000-event history limit and 256 KiB payload cap make fine-grained polling loops painful, and "each retry will be charged as an additional state transition" penalises exactly the retry-heavy behaviour this domain needs.
- **BullMQ/Celery + your own state machine**: choose this only if you must. You will reimplement durable timers, replay, versioning, and visibility, and you will get idempotency wrong at least once with real money attached. The one legitimate use: BullMQ as the *transport* for GPU render jobs underneath Temporal activities, where you want fine-grained queue control Temporal doesn't give you.

### 5.4 Workflow decomposition (Temporal, concrete)

```
CampaignWorkflow (long-lived, per campaign, continue-as-new every ~30 days)
├── child: CreativeGenerationWorkflow (per concept)
│     ├── activity generateScript            timeout 5m,  retry 3
│     ├── activity submitVideoJob            timeout 2m,  retry 5, idempotent by concept id
│     ├── loop: activity pollVideoJob        timeout 30s; workflow sleeps 15s between
│     ├── activity assembleRender            timeout 30m, heartbeat 60s, retry 2
│     └── activity uploadRenderToR2          timeout 10m, retry 5
├── child: PublishWorkflow (per ad variant)  workflowId = "publish:<idem>"
│     ├── activity ensureAdLabel
│     ├── activity uploadVideoToMeta         chunked; heartbeat per chunk w/ offset
│     ├── loop: activity checkVideoStatus    until status.video_status == 'ready'
│     ├── activity createCreative
│     ├── activity createAdPaused            execution_options=['synchronous_ad_review']
│     ├── (optional) signal wait: approval   Promise.race([condition, sleep('48h')])
│     └── activity activateCampaign          <-- guarded by spend_authority
├── sleep('72h')
├── child: MeasurementWorkflow
│     ├── activity startInsightsJob          -> report_run_id
│     ├── loop: activity pollInsightsJob     handle 'Job Skipped' -> resubmit
│     └── activity persistMetricSnapshot
└── activity decide -> {SCALE | HOLD | KILL | ITERATE}
```

Rules that matter:
- **Activities are the only place I/O happens.** Every Meta call, every R2 write, every LLM call.
- **Heartbeat long activities** (`assembleRender`, chunked upload) and carry the byte offset in the heartbeat details so a retry resumes rather than restarts. This composes perfectly with Meta's `upload_phase=transfer` offset protocol.
- **Never sleep inside an activity for a rate limit.** Throw `RateLimited(seconds)`, sleep in the workflow.
- **Continue-as-new** the long-lived `CampaignWorkflow` on a schedule — a campaign that runs for a year at one poll/hour would otherwise approach the 51,200-event ceiling.

---

## 6. Data model

### 6.1 Entities

```
tenant ──< advertiser ──< brand ──< brand_kit          (logos, fonts, palettes, voice, do/don't)
                      ├─< product ──< offer            (price, discount, urgency, validity window)
                      ├─< meta_connection              (business_id, tokens, granted assets)
                      └─< ad_account                   (meta id, currency, timezone_id, min_daily_budget)

angle ──< creative_concept ──< script ──< shot ──< asset ──< render ──< ad_variant
  │                                                             │
  │                                                             └──< derivative (aspect ratio, length cut)
  └── hypothesis (what we believe about the audience)

ad_variant ──< publish_intent ──< publish_record ──< metric_snapshot
                                        │
experiment ──< experiment_arm ──────────┘
learning (insight) <── derived from metric_snapshot + experiment
```

### 6.2 The id discipline (trap #1)

**Never let a Meta id be a primary key. Never let an internal id leak into a Meta field except as a label.**

```sql
CREATE TABLE publish_record (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- internal, immutable
  tenant_id       uuid NOT NULL,
  ad_variant_id   uuid NOT NULL REFERENCES ad_variant(id),
  ad_account_id   text NOT NULL,          -- 'act_123...' as TEXT
  meta_campaign_id text,                  -- TEXT. always. 
  meta_adset_id    text,
  meta_ad_id       text,
  meta_creative_id text,
  meta_video_id    text,
  api_version      text NOT NULL,         -- 'v26.0' -- which version created this
  idem_key         text NOT NULL,
  effective_status text,                  -- last observed
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idem_key)
);
CREATE UNIQUE INDEX ON publish_record (ad_account_id, meta_ad_id) WHERE meta_ad_id IS NOT NULL;
```

Traps, all of which cost real time:

- **Meta ids exceed 2^53.** They arrive as JSON *strings* in most responses and as *numbers* in a few. In JS, `JSON.parse('{"id": 23851234567890123}')` loses precision **silently**. Parse with a reviver or `JSON.parse` on a bigint-aware parser for any Meta payload; store as `text` in Postgres; never `bigint`, never JS `number`.
- **`act_` prefix.** `AdAccount.id` is `act_123456`; `AdAccount.account_id` is `123456`. Endpoints take `act_123456`. Insights rows return `account_id` (unprefixed). Normalise at the boundary and store both.
- **Meta objects are mutable and reusable.** An `AdCreative` can be shared across ads; a `video_id` across creatives. Model these as many-to-many, not as columns on `ad`.
- **Deletion is not deletion.** `status=DELETED` and `ARCHIVED` objects vanish from default list queries but still exist. If you reconcile by listing without `effective_status` filters, you will "discover" your own objects missing and recreate them. Airbyte documents exactly this failure: "When status filters are empty, archived/deleted records are silently omitted."
- **Record the API version that created each object.** When v26 changes an enum's semantics, you need to know which rows were written under which contract.

### 6.3 Creative lineage (trap #2)

The learning loop is only as good as your ability to attribute performance to a *cause*. That requires the full chain to be first-class rows, not blobs:

```
angle(id, hypothesis_text, audience_desc, emotional_driver)
  -> creative_concept(id, angle_id, hook_type, structure, prompt_bundle_hash)
    -> render(id, concept_id, engine, engine_version, model_id, seed,
              params_hash, content_sha256, duration_ms, aspect, cost_minor, cost_currency)
      -> ad_variant(id, render_id, copy_variant_id, cta_type, landing_url,
                    placement_set, aspect)
```

- `params_hash` = SHA-256 of the canonicalised generation inputs. This is your cache key (§7) *and* your experimental unit.
- `content_sha256` = hash of the produced bytes. Two different `params_hash` can yield the same bytes (dedupe); one `params_hash` can yield different bytes across engine versions (drift). Keep both.
- Store `engine_version` and `model_id` on the render. When a provider silently changes a model behind a stable name, your only evidence will be a step change in `content_sha256` diversity at a known timestamp.
- **Do not let an `ad_variant` differ in more than one dimension from its sibling** if you intend to learn from the comparison. Enforce this at write time with a `variant_axis` column naming the single thing that varies.

### 6.4 Metrics: append-only snapshots, never "latest state" (trap #3)

**Meta's numbers for a past day keep changing for ~28 days.** Airbyte's connector deliberately re-syncs with a "lookback window (default 28 days) to capture Facebook's delayed conversion attribution updates." Source: <https://docs.airbyte.com/integrations/sources/facebook-marketing>

If you store `metrics(ad_id, date) PRIMARY KEY` and upsert, you destroy your own history and can never answer "what did we believe when we made that decision?" — which is precisely the question an autonomous system must be auditable on.

```sql
CREATE TABLE metric_snapshot (
  tenant_id          uuid        NOT NULL,
  ad_account_id      text        NOT NULL,
  level              text        NOT NULL,   -- account|campaign|adset|ad
  object_id          text        NOT NULL,   -- meta id
  stat_date          date        NOT NULL,   -- the day the metrics describe
  observed_at        timestamptz NOT NULL,   -- when WE pulled it
  attribution_setting text       NOT NULL,   -- from AdsInsights.attribution_setting
  attribution_windows text[]     NOT NULL,   -- what we asked for
  breakdown_key      jsonb       NOT NULL DEFAULT '{}',  -- {} for unbroken rows
  api_version        text        NOT NULL,
  spend_minor        bigint      NOT NULL,
  impressions        bigint,
  clicks             bigint,
  actions            jsonb,                  -- raw action array, don't flatten prematurely
  action_values      jsonb,
  video_curve        jsonb,                  -- video_play_curve_actions
  raw                jsonb       NOT NULL,   -- full row, for re-derivation
  PRIMARY KEY (tenant_id, level, object_id, stat_date, attribution_setting, observed_at)
) PARTITION BY RANGE (stat_date);
```

- **Partition monthly**, drop partitions older than your retention. This table is the one that grows without bound.
- `attribution_setting` in the primary key is non-negotiable. The same ad-day under `7d_click,1d_view` and under `1d_click` are different facts, not conflicting versions of one fact.
- Keep `raw`. Meta adds fields; you will want to re-derive metrics from history without re-querying (which you often *cannot* do, because of the 37-month limit and because attribution has since settled).
- Build a `metric_current` **materialised view** (latest `observed_at` per key) for dashboards. Never let the decision engine read a mutable table.

**Decision provenance:** every automated decision stores the exact `metric_snapshot` primary keys it consulted:
```sql
CREATE TABLE decision (
  id uuid PRIMARY KEY, tenant_id uuid, subject_kind text, subject_id text,
  action text,                       -- SCALE|HOLD|KILL|ITERATE|ESCALATE
  decided_at timestamptz NOT NULL,
  policy_version text NOT NULL,      -- which rule/model version decided
  inputs jsonb NOT NULL,             -- snapshot PKs + computed features
  rationale text,
  applied_publish_record_id uuid
);
```
Without this you cannot debug a bad decision, and you cannot honestly claim the system "learns" — you can only claim it changes.

### 6.5 Money

Every monetary column is `bigint` in **minor units** plus a `currency` column. Meta's `daily_budget`, `lifetime_budget`, `bid_amount`, `spend_cap` are int64 minor units in the **ad account's** currency (`AdAccount.currency`), and "in cents for USD/EUR, basic unit for JPY/KRW" — JPY has no minor unit, so `bid_amount: 100` means ¥100, not ¥1. Never store money as float. Never assume the tenant's billing currency equals the ad account's currency.

Also store `AdAccount.timezone_id` / `timezone_name` per account: `stat_date` from insights is in the **ad account's** timezone, not UTC. Comparing two accounts' "yesterday" without normalising is a subtle, permanent error.

---

## 7. Storage and asset caching

### 7.1 Numbers

**Cloudflare R2** — <https://developers.cloudflare.com/r2/pricing/>
| | Standard | Infrequent Access |
|---|---|---|
| Storage | **$0.015 / GB-month** | **$0.01 / GB-month** (30-day minimum duration) |
| Class A ops (writes/lists) | **$4.50 / million** | $9.00 / million |
| Class B ops (reads) | **$0.36 / million** | $0.90 / million |
| Retrieval | — | $0.01 / GB |
| **Egress** | **$0** | **$0** |
| Free tier | 10 GB-mo, 1M Class A, 10M Class B | — |

**AWS S3, us-east-1** — from the AWS Price List API (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json`, retrieved 2026-09-02):
| Item | Price |
|---|---|
| Standard storage, first 50 TB | **$0.023 / GB-mo** |
| Standard, next 450 TB | $0.022 / GB-mo |
| Standard, over 500 TB | $0.021 / GB-mo |
| Standard-Infrequent Access | **$0.0125 / GB-mo** + $0.01/GB retrieval |
| One Zone-IA | $0.010 / GB-mo + $0.01/GB retrieval |
| Glacier Instant Retrieval | **$0.004 / GB-mo** + $0.03/GB retrieval |
| Intelligent-Tiering Frequent | $0.023 / GB-mo (same tiers as Standard) |
| Intelligent-Tiering Infrequent | $0.0125 / GB-mo |
| Intelligent-Tiering Archive Instant | $0.004 / GB-mo |
| Intelligent-Tiering Deep Archive Access | $0.00099 / GB-mo |
| Express One Zone | $0.11 / GB-mo |
| PUT/COPY/POST/LIST | **$0.005 / 1,000** |
| GET and all other | **$0.0004 / 1,000** ($0.004 per 10,000) |
| Lifecycle transition to Standard-IA / One Zone-IA / Int-Tiering | $0.01 / 1,000 |
| Lifecycle transition to Glacier Instant Retrieval | $0.02 / 1,000 |

Internet egress from S3 is billed under AWS Data Transfer, not the S3 price list (the S3 list shows only `$0.0 per GB for S3-DT-AWS Outbound`, i.e. AWS-internal). Public list price is ~$0.09/GB after 100 GB/month free — **UNVERIFIED against the AWS price list in this session**; verify before modelling.

### 7.2 Worked cost model

Assume, per creative concept fully retained:

| Artifact | Size |
|---|---|
| 4 × generated source clips, 5 s, high bitrate | 4 × 20 MB = 80 MB |
| 1 assembled master (ProRes-lite or high-bitrate H.264) | 60 MB |
| 5 delivery derivatives (9:16, 4:5, 1:1, 16:9, 6 s cut) @ ~15 MB | 75 MB |
| Thumbnails, waveforms, captions, JSON | ~5 MB |
| **Total** | **~220 MB** |

100 advertisers × 40 concepts/month = **4,000 concepts/month ≈ 880 GB/month accreted**.

| Horizon | Stored | R2 Standard | S3 Standard |
|---|---|---|---|
| Month 1 | 0.88 TB | **$13** | $21 |
| Month 12 | 10.6 TB | **$159** | $250 |
| Month 24 | 21.1 TB | **$317** | $486 |

Egress: Meta pulls each delivery video once via `file_url` (4,000 × 15 MB = 60 GB/mo), plus dashboard previews (say 5× that = 300 GB/mo). **R2: $0. S3 at $0.09/GB: ~$32/month** and it scales with your UI usage, which is the part you least want coupled to storage bills.

**R2 wins on both axes, and the egress asymmetry is what decides it** — because the `file_url` upload path (Meta fetching the video from your bucket) turns every publish into egress.

**Tiering policy that actually works here:**
- **Hot (R2 Standard):** delivery derivatives for any ad whose `effective_status` is not terminal, plus everything <30 days old.
- **Warm (R2 Infrequent Access, $0.01/GB-mo, 30-day minimum):** masters and source clips older than 30 days. Note the 30-day minimum-duration charge — do not tier objects you might delete next week.
- **Cold/delete:** source clips for concepts that never produced a published ad, after 60 days. This is typically **40-60% of total bytes** and it has no future value. Deleting it is the single biggest storage lever.
- **Never delete:** delivery derivatives of ads that ever ran, the render manifest, and thumbnails. You need them for audit and for the learning corpus.

### 7.3 Content-addressed caching

```
r2://renders/{sha256[0:2]}/{sha256[2:4]}/{sha256}          # immutable bytes
r2://manifests/{tenant}/{render_id}.json                    # points at content hashes
```

Two distinct keys, and confusing them is a real bug source:

- **`params_hash`** = `sha256(canonical_json(generation_inputs))` including `engine`, `model_id`, `prompt`, `seed`, `duration`, `aspect`, `brand_kit_version`. Cache key: "have we already asked for exactly this?" Hit → skip a paid generation.
- **`content_sha256`** = hash of the resulting bytes. Dedupe key: "do we already store these bytes?" Hit → skip the upload, reuse the object.

Canonicalisation rules (get these wrong and your hit rate is 0%): sort object keys, drop nulls, round floats to a fixed precision, exclude anything non-deterministic (timestamps, request ids, user agent). Version the canonicaliser and include its version in the hash input, so changing the rules invalidates cleanly instead of colliding.

Store the mapping `content_sha256 → {ad_account_id → meta_video_id | meta_image_hash}` — Meta ids are **per ad account**, so the same bytes uploaded to two advertisers yield two different `video_id`s. A cache keyed only on content hash will hand tenant B tenant A's `video_id`, which will fail with a permissions error at best and cross-tenant-leak at worst.

Set `Cache-Control: public, max-age=31536000, immutable` on content-addressed objects and put the R2 bucket behind a Cloudflare zone for preview serving.

---

## 8. Credentials, scoping and compliance

### 8.1 How you actually get access to a client's ad account

**Facebook Login for Business**, not classic Facebook Login. Source: <https://developers.facebook.com/docs/facebook-login/facebook-login-for-business>

You create **configurations** in the App Dashboard, each specifying: token type (user vs system-user), required assets, permissions, and expiration. Each gets a **Configuration ID**.

For a server-to-server automation platform you want a **System User Access Token (SUAT)**:
```js
FB.login(cb, {
  config_id: '<CONFIG_ID>',
  response_type: 'code',
  override_default_response_type: true
});
// -> authorization code -> exchange server-side for the SUAT
```
Key properties, quoted:
- SUATs are "issued to the Tech Provider's infrastructure, not individual users", "associated with the client's business portfolio".
- The token expiration "Defaults to **never expire** for the common offline server-to-server communication."
- Requires the authorization-code grant; "Only available via web surfaces."
- "Advanced Access approval via Meta App Review needed for accessing unowned businesses."

**Critical constraint on attribution of actions**, from the system users doc: *"If you try to use system user tokens to work on ad objects or Pages on behalf of a real user of your software, you cannot link this user to those actions unless you take them through Facebook Login."*
Source: <https://developers.facebook.com/docs/marketing-api/system-users>

Read that carefully. It means: if your product must show "Jane approved this budget increase" *in Meta's own audit trail*, a SUAT will not do it — every action appears as your system user. For a fully-autonomous platform that is arguably correct and even desirable, but you must then keep your **own** immutable audit log (§6.4 `decision`), because Meta's will attribute everything to one identity.

### 8.2 Access tiers and the onboarding cliff

| | Limited Access (default) | Full Access (post-review) |
|---|---|---|
| Rate limits | "Heavily rate-limited per ad account" (`300 + 40 × ads`) | "Lightly rate-limited" (`100,000 + 40 × ads`) |
| System users | **1 system user + 1 admin system user** | **10 system users + 1 admin system user** |
| Business Manager / Catalog API | Limited | Full |

**Upgrade requirements (both must hold):**
1. "Have successfully made at least **500 Marketing API calls in the last 15 days**"
2. "Have made Marketing API calls with an **error rate of less than 15%** in the last 500 calls"

Then click "+Upgrade" in the App Dashboard.
Source: <https://developers.facebook.com/docs/marketing-api/access>

**Business Verification is a hard gate.** "As of February 1, 2023" apps requesting advanced access must complete Business Verification; without it, users from other businesses cannot grant permissions and **"all features will be inactive."** Two steps: connect the app to a Business (App Dashboard → Settings → Basic → Verification), then verify the Business in Business Manager.
Source: <https://developers.facebook.com/docs/development/release/business-verification>

**Plan for this taking weeks, and plan the sequencing:** you cannot get Full Access without 500 real API calls, and you cannot make 500 real calls against client accounts without Advanced Access to `ads_management`, which needs App Review + Business Verification. The bootstrap path is: your own ad account (or a test account) → 500 calls → upgrade → App Review for advanced `ads_management` → then onboard clients. Budget 6-10 weeks. The **10 system user cap even on Full Access** is a real multi-tenancy constraint (§10).

Permissions: `ads_management` (write), `ads_read` (read-only), plus `business_management`, `pages_show_list`, `pages_read_engagement`, `instagram_basic` for the assets a creative needs.

### 8.3 The Platform Terms obligations you are signing up to

From Meta Platform Terms (<https://developers.facebook.com/terms/>), the clauses that shape architecture:

- **§6.a.iv — "protect and not transfer, share, or solicit Meta user IDs, access tokens, or app secrets"** except with Service Providers who help operate your platform. This is the direct legal basis for envelope encryption, and it means your *cloud provider and any vendor that can read plaintext tokens* is a Service Provider requiring a written agreement.
- **§6.a.i** — safeguards that "Meet or exceed industry standards given the sensitivity of the Platform Data", plus "an easily accessible way for people to report security vulnerabilities" (i.e. publish a `/security.txt` and a real contact).
- **§3.d.i.2** — prompt deletion when retention is no longer necessary, when you discontinue the service, when Meta requests it, when the user requests it, or when required by law. **Design a working tenant-purge job on day one.**
- **§3.d.i.1** — provide users "an easily accessible and clearly marked way" to request modification or deletion.
- **§3.a** — no selling/licensing/purchasing Platform Data; no discriminatory processing; no surveillance.
- **§5.a.i** — written agreements with Service Providers; on termination they must "immediately cease using Platform and Processing Platform Data and promptly delete all Platform Data."
- **§7.b-c** — Meta audit rights, "no more than once a calendar year unless there is a Necessary Condition", **10 business days' notice**, "all necessary physical and remote access", and you reimburse audit costs if violations are found.

Practical translation: keep a **subprocessor register**, keep **access logs for token decryption**, and be able to produce a **data-flow diagram and deletion evidence** within 10 business days.

Additionally, apps with advanced access are subject to Meta's periodic **Data Protection Assessment** — the canonical URL for its documentation was not reachable in this session (**UNVERIFIED**); confirm current requirements before App Review.

### 8.4 Token storage design

**Envelope encryption with AWS KMS.** Pricing (AWS Price List API, `awskms/current/us-east-1`, retrieved 2026-09-02):
- **$1.00 per customer-managed KMS key version per month**
- **$0.03 per 10,000 requests** ($0.000003/request) for symmetric operations
- **20,000 free requests/month** (global free tier)
- Asymmetric: $0.15/10k (non-RSA-2048), RSA-2048 $0.03/10k; `GenerateDataKeyPair` RSA is **$12/10k** — never use it here.

Scheme:
```
1 CMK per region per environment            -> $1-$4/month total. Not per tenant.
Per-tenant data key: GenerateDataKey(CMK, AES_256)
  store: encrypted_data_key (ciphertext blob) on the tenant row
  use:   AES-256-GCM over the token, with AAD = tenant_id|purpose|key_version
Cache the decrypted data key in memory for <= 5 minutes, never on disk.
```
Encryption context (AAD) binding to `tenant_id` is what stops a compromised row from being decrypted into the wrong tenant's context. Use it; it is free.

Cost at 100 tenants with a 5-minute key cache and 20 workers: roughly 20 workers × 12 decrypts/hour × 24 × 30 ≈ 173k KMS calls/month ≈ **$0.52/month**. KMS cost is a rounding error; the reason to use it is auditability (CloudTrail records every `Decrypt` with the encryption context) and the §6.a.iv obligation.

Schema:
```sql
CREATE TABLE meta_credential (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  business_id       text NOT NULL,
  token_type        text NOT NULL,        -- SYSTEM_USER | USER
  ciphertext        bytea NOT NULL,       -- AES-256-GCM
  iv                bytea NOT NULL,
  auth_tag          bytea NOT NULL,
  encrypted_dek     bytea NOT NULL,       -- KMS-wrapped data key
  key_version       int  NOT NULL,
  scopes            text[] NOT NULL,      -- as returned by /debug_token
  granted_ad_accounts text[] NOT NULL,
  granted_pages       text[] NOT NULL,
  config_id         text,                 -- FB Login for Business configuration
  expires_at        timestamptz,          -- NULL for never-expiring SUAT
  last_validated_at timestamptz,
  revoked_at        timestamptz
);
```
- Store the **hash** of the token (`sha256`) in a separate index column if you need to detect "same token supplied twice"; never index the plaintext.
- **Validate on a schedule** with `GET /debug_token?input_token=<t>&access_token=<app_token>`, weekly. A "never expires" SUAT can still be invalidated by the client removing your app, changing a password, or Meta revoking. `AdAccount.user_access_expire_time` is a readable field — surface it.
- **Rotation:** because SUATs don't expire, rotation is a *re-consent* flow, not a refresh. Build the re-auth prompt path and a `credential_health` state per tenant (`OK | DEGRADED | REVOKED`) that gates the pipeline. On error `190` or `200`/`294`, mark `REVOKED` and stop all workflows for that tenant immediately — do not retry, you will just burn quota and inflate your error rate (which, per §3.1, shrinks your insights quota).
- **Never log tokens.** Add a serialiser deny-list and a CI grep for `access_token` in log statements.

---

## 9. Observability and cost control

### 9.1 Trace shape

One trace per ad variant, spanning days. Temporal emits its own spans via the OpenTelemetry interceptor; link them under a root span keyed by `ad_variant_id`, and carry `tenant_id`, `ad_account_id`, `campaign_id` as attributes on **every** span (they are your primary filter axis, not a detail).

Use the OpenTelemetry **GenAI semantic conventions** for generation spans. Note: these **moved out of the main semconv repo** into <https://github.com/open-telemetry/semantic-conventions-genai>, and the whole document is currently **status: Development** (not stable) — expect churn.

Attribute names verified in that repo (`docs/gen-ai/gen-ai-spans.md`):
```
gen_ai.operation.name          (Required)
gen_ai.provider.name           (Required)  <- NOT gen_ai.system; renamed
gen_ai.request.model
gen_ai.response.model
gen_ai.response.id
gen_ai.response.finish_reasons
gen_ai.usage.input_tokens / gen_ai.usage.output_tokens
gen_ai.usage.cache_read.input_tokens / gen_ai.usage.cache_write.input_tokens
gen_ai.usage.reasoning.output_tokens
gen_ai.usage.image.input_tokens / gen_ai.usage.image.output_tokens
gen_ai.usage.audio.input_tokens / gen_ai.usage.audio.output_tokens
gen_ai.output.type, gen_ai.input.messages, gen_ai.output.messages
gen_ai.conversation.id, gen_ai.agent.name, gen_ai.tool.name
```
Span name convention: **`{gen_ai.operation.name} {gen_ai.request.model}`**.

Note that there is **no `gen_ai.usage.cost` attribute** — cost is your own derived metric. Emit it as a separate metric with the same attribute set.

Do **not** put prompts/outputs (`gen_ai.input.messages`) into traces for a multi-tenant product without a redaction gate; they contain client business data governed by §3.a.

### 9.2 The cost ledger

Traces are sampled and expire. Money does not. Keep a separate, unsampled, append-only ledger:

```sql
CREATE TABLE cost_event (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  tenant_id     uuid NOT NULL,
  advertiser_id uuid,
  campaign_id   uuid,
  ad_variant_id uuid,
  render_id     uuid,
  category      text NOT NULL,   -- LLM | VIDEO_GEN | IMAGE_GEN | TTS | RENDER_COMPUTE
                                 -- | STORAGE | EGRESS | ORCHESTRATION | MEDIA_SPEND
  provider      text NOT NULL,
  model_id      text,
  units         numeric NOT NULL,
  unit_kind     text NOT NULL,   -- tokens | seconds_of_video | gpu_seconds | gb_month | actions
  cost_minor    bigint NOT NULL,
  currency      text NOT NULL,
  workflow_id   text,            -- Temporal workflow id -> joins to the trace
  idem_key      text             -- dedupe: same key never billed twice
);
CREATE UNIQUE INDEX ON cost_event (idem_key) WHERE idem_key IS NOT NULL;
```

Derived views you must have on day one:
- `cost_per_published_ad` = Σ(all categories except MEDIA_SPEND) / count(publish_record). This is your unit economics. If it exceeds ~5-10% of the ad's media budget the product does not work.
- `cost_per_tenant_per_day`, split generation vs media spend.
- **`generation_cost_to_media_spend_ratio` per campaign.** A runaway loop shows up here first: generation cost climbing while media spend is flat means you are regenerating without publishing.

### 9.3 Runaway-loop detection — the alerts that matter

An autonomous system that spends money needs circuit breakers, not dashboards. Implement all of these as *hard stops*, not notifications:

| Guard | Trigger | Action |
|---|---|---|
| Per-tenant daily generation budget | `Σ cost_event(non-media) today > tenant.daily_gen_cap` | Halt all generation workflows for tenant; page |
| Publish velocity | `> N ads published per ad_account per hour` (N ≈ 20) | Reject further publishes; require human token |
| Regeneration ratio | `renders_created / ads_published > 10` over 24 h | Halt concept generation; likely a prompt/validation loop |
| Spend authority drift | `Σ Meta daily_budget of ACTIVE adsets ≠ spend_authority.committed ± 1%` | Pause all ACTIVE campaigns for that account; page |
| Workflow retry storm | Same `workflowId` retried > 20× in an hour | Fail the workflow terminally; page |
| Meta error rate | `4xx/total > 10%` over 1,000 calls per app | Throttle to 10% traffic; page — **this directly protects your insights quota (§3.1)** |
| Duplicate detection | >1 result from a `*bylabels` reconciliation query | Immediate stop; §4 already treats this as an alarm |
| Zero-delivery | Ad `ACTIVE` for 24 h with `impressions == 0` | Escalate; likely `PENDING_BILLING_INFO` or DSA fields missing |

Two structural safeties beyond alerting:
1. **A global kill switch** readable by every workflow at every step (`if (await isHalted(tenantId)) throw new ApplicationFailure('HALTED', {nonRetryable: true})`). It must be settable without a deploy.
2. **A monotonic daily spend ceiling per ad account enforced in your code**, independent of Meta's `spend_cap`. Meta's `spend_cap` is an account-lifetime cap with a $100 minimum and is not a substitute.

---

## 10. Multi-tenancy and isolation

**Isolation model: shared database, `tenant_id` on every row, Postgres Row-Level Security, separate KMS data key per tenant, separate Temporal task queue per tenant tier.**

```sql
ALTER TABLE publish_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON publish_record
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```
Set `app.tenant_id` from the connection pool per request/activity. RLS is the backstop for the query you forget to filter — and in a system where a cross-tenant leak means publishing advertiser A's creative to advertiser B's ad account, you want the backstop.

Isolation axes and where each lives:

| Axis | Mechanism |
|---|---|
| Data | `tenant_id` + RLS + AAD-bound envelope encryption (a leaked row is undecryptable in another tenant's context) |
| Rate limit | Redis token bucket keyed by `ad_account_id` — **never a global limiter**; one noisy tenant must not throttle another |
| Generation cost | Per-tenant daily cap enforced before any paid call (§9.3) |
| Compute | Separate Temporal **task queues** per tier (`publish-standard`, `publish-priority`); workers poll one queue, so a backlog in one tier cannot starve another |
| Storage | R2 key prefix `renders/{tenant}/...` for manifests; content-addressed blobs are shared *only* if you are certain identical bytes across tenants is acceptable — **it usually is not** (a tenant's brand asset must not be reachable from another tenant's manifest). Prefix content-addressed objects by tenant unless you have an explicit shared-stock-asset namespace. |
| Meta identity | See below |

**The Meta-side multi-tenancy constraint.** Full Access allows **10 system users + 1 admin system user** per app. That is not 10 tenants — with Facebook Login for Business, each client's SUAT is issued against *their* business portfolio, so tenant scaling comes from tokens, not from your system-user count. But the 10-system-user limit does cap how many *distinct internal identities* you can operate under, which matters if you want per-tier or per-region separation. **Verify with Meta before designing around >10 internal identities** (**partially UNVERIFIED**: the interaction between the system-user cap and client-issued SUATs is not spelled out in the access doc).

**Noisy-neighbour on the app-level quota is the real risk.** `X-App-Usage` is per *app*, shared across all tenants. `call_count = 200 × number_of_users` per hour app-wide. If one tenant's backfill drives `X-App-Usage.call_count` to 100, **every** tenant is throttled. Mitigations, in order of effectiveness:
1. Give each traffic class a fixed share of the app budget and enforce it in the client (e.g. MEASURE never exceeds 60% of app quota).
2. Prefer async insights jobs over paginated sync reads — one job costs far fewer calls than 200 pages.
3. If you outgrow one app, split into multiple Meta apps by tenant cohort. This is a real, used strategy and it is much easier to do at design time than later (tokens are app-scoped, so migrating a tenant between apps means re-consent).

---

## 11. Testing a system that spends real money

Four layers, each catching a different class of bug.

### 11.1 `validate_only` — Meta's own dry run

`execution_options: ['validate_only']` is accepted on Campaign, AdSet, **and Ad** creation (verified: `class ExecutionOptions` in `campaign.py`, `adset.py`, `ad.py`). Meta validates the full request — targeting, budget minimums, enum validity, permission — and returns errors **without creating anything**.

This is not a mock; it is the real validator. Run it in CI against a real (test) account for every request template you generate. It catches the entire class of "your enum is valid in v25 but not v26" bugs that unit tests cannot.

Pair it with `include_recommendations` to get Meta's own suggestions, which are a free input to your optimisation logic.

### 11.2 Recorded-cassette contract tests

Do not hand-write Graph API mocks; they drift and they lie. Instead:
- Record real responses (including **headers** — the rate-limit headers are part of the contract) into fixtures, with tokens and ids scrubbed.
- Replay them with `nock`/`msw` (TS) or `vcrpy`/`responses` (Python).
- **Refresh fixtures on a schedule (weekly CI job) against a real test account**, and fail the build when a recorded response's *shape* changes. That job is your early warning for a Meta-side change, and it is the only automated way to notice that a field you depend on quietly disappeared in v26.1.

Test these specific responses explicitly, because they are the ones that break autonomous systems:
- `{"status": {"video_status": "processing"}}` → your poll loop must not proceed.
- `async_status: "Job Skipped"` → resubmit, don't fail.
- `effective_status: "PENDING_BILLING_INFO"` → escalate, don't retry.
- `effective_status: "IN_PROCESS"` → wait, don't recreate.
- A batch response where sub-request 3 has a `429`-equivalent error body while the outer HTTP status is 200.
- `error.code: 613, error_subcode: 5044001` → short backoff, not long.
- A response where `id` is a JSON number > 2^53 → assert no precision loss.

### 11.3 Dry-run mode as a first-class product mode

Not a test-only flag — a real runtime mode with three levels, selectable per tenant:

| Mode | Generation | Meta writes | Money |
|---|---|---|---|
| `SIMULATE` | Stubbed/cached | none (all calls logged to the intent ledger only) | $0 |
| `VALIDATE` | Real | `validate_only` only | generation cost only |
| `STAGE` | Real | Real objects, **always `status=PAUSED`**, never activated | generation cost only |
| `LIVE` | Real | Real, activation permitted | full |

Implement this as a capability check inside the API client, not as branching in workflow code — a single `client.mode` that refuses `status: ACTIVE` and refuses `POST /{campaign_id} {status: ACTIVE}` unless `LIVE`. Then no workflow author can accidentally spend money. Assert it in a test that enumerates every mutation call site.

`STAGE` is the highest-value mode: it exercises the *real* API, real video encoding, real ad review (with `synchronous_ad_review` you even get the approve/reject verdict), and real object ids — the only thing it does not do is start delivery.

### 11.4 Staging path and test accounts

**Sandbox/test ad accounts:** Meta does provide test ad accounts (created from the App Dashboard) whose ads do not deliver or spend. The canonical documentation URL was not reachable in this session (`/docs/marketing-api/test-accounts` and `/docs/marketing-api/overview/test-accounts` both 404) — **UNVERIFIED**. Treat the following as an open question: how many test accounts per app, whether insights return synthetic data, and which objectives are supported. Do not build your CI strategy on assumed test-account behaviour until you have confirmed it.

The dependable staging path, which does not rely on unverified sandbox semantics:
1. A **real ad account you own**, funded, with `spend_cap` set to a small real number ($100 minimum per docs) as a hard backstop.
2. All CI/staging runs in `STAGE` mode → real PAUSED objects.
3. A nightly reaper that archives every object in the staging account older than 24 h, matched by an `env:staging` AdLabel.
4. Exactly one weekly `LIVE` canary: one ad, $5/day, activated, measured, killed. This is the only way to test the parts of the system that only exist when delivery happens (insights shape, attribution restatement, the decision loop).

**Temporal replay tests** close the loop: export the history of a production workflow that misbehaved and replay it against new code in a unit test. This catches non-determinism *before* deploy, which for a system with thousands of in-flight multi-day workflows is the difference between a bad afternoon and a bad quarter.

---

## 12. Existing open source worth borrowing from

| Project | What to take | Notes |
|---|---|---|
| **Airbyte `source-facebook-marketing`** <https://docs.airbyte.com/integrations/sources/facebook-marketing> | The **rate-limit governor** (`MyFacebookAdsApi`, `_parse_call_rate_header`, `_compute_pause_interval`, 85/95 thresholds, 2/10 min pauses), the retryable error-code set, the "reduce the amount of data" page-shrink strategy, the async-insights job runner, and the 28-day attribution lookback re-sync pattern. | Currently targets **v25.0** (as of connector 5.2.12-rc.1, May 2026) — one version behind v26.0. MIT-licensed portions; check the ELv2 boundary before copying wholesale. This is the single highest-value borrow in the list. |
| **`facebook-python-business-sdk`** <https://github.com/facebook/facebook-python-business-sdk> | Use as a **codegen source**: every `Field` class and enum, plus `video_uploader.py`'s chunked-upload state machine including the `error_data.start_offset` recovery. | v26.0.1, actively maintained, 8-day lag behind Graph releases. |
| **`facebook-nodejs-business-sdk`** | The `main` branch source for cross-checking TS types. | **Do not depend on the npm package** — stuck at 24.0.1 since 2025-11-21 (§1.3). |
| **`pipeboard-co/meta-ads-mcp`** <https://github.com/pipeboard-co/meta-ads-mcp> | A working MCP-shaped tool surface over Meta Ads (launch campaigns, upload creatives, update budgets, analyse performance). Useful as a reference for *tool granularity* if you expose an agent interface. | Read the auth/safety model; it is a hosted remote MCP, so its threat model differs from yours. |
| **Temporal samples** (`temporalio/samples-typescript`, `samples-python`) | The polling, saga/compensation, and long-running-with-continue-as-new patterns map almost one-to-one onto this pipeline. | |
| **OpenTelemetry GenAI semconv** <https://github.com/open-telemetry/semantic-conventions-genai> | Attribute names for generation spans (§9.1). | Status: **Development**. Pin the spec version you instrument against. |

Deliberately not recommended: Singer `tap-facebook` (largely superseded by the Airbyte connector for this purpose), and the various "Facebook Ads automation" GitHub projects that wrap the SDK without solving rate limits or idempotency — they have nothing you cannot write in a day.

---

## 13. Gotchas

Ordered roughly by how much time each costs when you hit it cold.

1. **`npm i facebook-nodejs-business-sdk` gives you v24.0 in September 2026.** The package's `dist-tags.latest` is 24.0.1, published 2025-11-21, while the repo is on 26.0.1. Your calls silently go to a 10-month-old API version. (§1.3)
2. **Meta object ids exceed 2^53 and JS loses precision silently.** `23851234567890123` round-trips through `JSON.parse` as a different number. Store as text everywhere; parse Meta payloads with a bigint-aware parser.
3. **Video upload goes to `https://graph-video.facebook.com`, not `graph.facebook.com`.** Verified in the SDK's `VideoUploadRequest.send()` (`url_override`).
4. **A creative built on a video still in `video_status: "processing"` produces a broken ad.** Poll `GET /{video_id}?fields=status` until `ready`. The SDK's built-in wait times out at **180 seconds** and raises a generic `FacebookError`.
5. **On a chunked-upload error, the resume offsets come back inside the error body**: `body['error']['error_data']['start_offset']` / `['end_offset']`. If you only read the success path you cannot resume.
6. **Rate-limit headers on batch requests live on each sub-response**, in a `headers` array per record — not on the outer HTTP response. A batch-heavy client that reads only outer headers is blind.
7. **`estimated_time_to_regain_access` is in MINUTES; every other header number is a PERCENT.** Mixing units gives you either a 100× too-long sleep or a hot loop.
8. **Your own 4xx rate reduces your insights quota**: `600/190,000 + 400 × active_ads − 0.001 × user_errors`. Buggy retries make the platform slower for everyone on the app.
9. **The QPS mutation limit (100/s per app+ad-account) is invisible in the BUC headers.** It surfaces only as `613` / subcode `5044001`. You need a separate token bucket.
10. **`effective_status: IN_PROCESS`** means the object exists but isn't materialised. Treating it as failure → double-create. It appears on Campaign, AdSet, Ad and AdCreative.
11. **`effective_status: PENDING_BILLING_INFO`** is a silent pipeline stall with no error anywhere — the advertiser's payment method failed. Alert on it explicitly.
12. **`ARCHIVED` / `DELETED` objects disappear from default list queries but still exist.** Reconciling without `effective_status` filters makes you "discover" your own objects missing.
13. **EU delivery requires `dsa_beneficiary` and `dsa_payor`** on the ad set (defaults available at `AdAccount.default_dsa_beneficiary` / `default_dsa_payor`). Omit them and EU-targeted ads don't deliver.
14. **`conversion_domain` is a create-time param on the Ad object** and is required for website-conversion objectives. Missing it fails the create, not the campaign — so you get a half-built tree. (Presence in `AdAccount.create_ad` param_types verified; the exact required-when conditions are **UNVERIFIED** — the `/docs/marketing-api/conversion-domain/` page 404s.)
15. **Budget minimums vary by currency and double in the US/UK/AU/JP.** Read `AdAccount.min_daily_budget` rather than hardcoding; it is a readable field.
16. **Money is minor units — except where it isn't.** JPY/KRW have no minor unit, so `bid_amount: 100` is ¥100. `bigint` + explicit currency, never float.
17. **Insights `stat_date` is in the ad account's timezone** (`AdAccount.timezone_id`/`timezone_name`), not UTC. Cross-account comparisons need normalising.
18. **Meta restates conversion metrics for ~28 days.** Upserting a `(ad_id, date)` row destroys your decision provenance. Append snapshots. (§6.4)
19. **Insights are limited to a 37-month lookback**, hard. Anything older is unrecoverable — archive `raw` yourself.
20. **`report_run_id` expires after 30 days** and `Job Skipped` is a normal, retryable outcome meaning the job expired from inactivity. Async insights "can take up to an hour to complete... including retry attempts."
21. **Batches are not atomic and cap at 50**, and you cannot batch multiple ad sets under the same campaign.
22. **The Graph API has no idempotency key.** Error 506 ("Duplicate Post") is a content heuristic, not a guarantee. (§4)
23. **System-user tokens cannot attribute actions to your end users** in Meta's audit trail — "you cannot link this user to those actions unless you take them through Facebook Login." Keep your own audit log.
24. **Business Verification is a hard gate**: without it "all features will be inactive" for other businesses' users, as of 2023-02-01.
25. **Full Access needs 500 calls in 15 days with <15% error rate** — a chicken-and-egg with App Review that adds weeks to the launch plan.
26. **`X-App-Usage` is app-wide, shared across all tenants.** One tenant's backfill throttles everyone. (§10)
27. **`execution_options: ['synchronous_ad_review']` exists on the Ad object** and turns a minutes-long async review into an inline verdict. Almost nobody uses it. (SDK `ad.py`)
28. **`AuthorizationCategory.POLITICAL_WITH_DIGITALLY_CREATED_MEDIA`** is the AI-media disclosure category for political ads. If your platform can touch `ISSUES_ELECTIONS_POLITICS`, this is a compliance requirement, not an option.
29. **R2's Infrequent Access class has a 30-day minimum billing duration.** Tiering objects you might delete next week costs more than leaving them hot.
30. **Meta image `hash` is per ad account.** Caching `content_sha256 → meta_video_id/image_hash` without an ad-account dimension will hand one tenant another tenant's asset id.
31. **Temporal's 51,200-event / 50 MB history limit** (warnings at 10,240 / 10 MB) means a long-lived campaign workflow that polls hourly needs `continue-as-new`.
32. **Inngest's and Restate's idempotency windows are 24 hours.** For a pipeline with multi-day sleeps, that is not sufficient as the only dedupe.
33. **Step Functions bills every retry as a state transition**, and caps execution history at 25,000 events / 256 KiB payloads — a bad fit for polling loops.
34. **OTel GenAI attribute `gen_ai.system` was renamed to `gen_ai.provider.name`** and the whole spec moved to a separate repo with status "Development". Pin the version.
35. **`facebook-business` declares no `requires_python`.** pip will install it anywhere.

---

## 14. Open questions / UNVERIFIED

These must be resolved before the corresponding design decision is locked.

1. **Meta test/sandbox ad accounts.** Both `developers.facebook.com/docs/marketing-api/test-accounts` and `.../overview/test-accounts` returned 404. Unknown: how many test accounts per app, whether ads deliver at all, whether insights return synthetic data, which objectives are supported, and whether `is_test_account` is a readable field. **Blocks: CI strategy (§11.4).**
2. **`conversion_domain` exact requirements.** Confirmed as a create param on `POST /act_{id}/ads`; the docs page 404s. Which objectives/optimisation goals require it, the expected format (eTLD+1?), and the error code on omission are unverified.
3. **Video file size / duration limits for `POST /advideos`.** Not stated on the endpoint reference or the Resumable Upload page. Also unverified: max file size for the Resumable Upload API.
4. **`is_ai_generated` semantics.** The bool exists as a create param on `advideos` in v26.0.1 codegen. Whether setting it triggers an AI-content label on delivery, affects reach, or is required by policy is unverified. **This is directly load-bearing for a fully-generative platform** — resolve with Meta before launch.
5. **Data Protection Assessment.** `/docs/development/release/data-protection-assessment` 404s. Frequency, scope, and consequences of failure for an app with advanced `ads_management` are unverified.
6. **System-user cap vs client-issued SUATs.** Full Access allows "10 system users + 1 admin system user". Whether client-portfolio SUATs obtained via Facebook Login for Business count against that cap is not stated. **Blocks: multi-tenancy identity design at scale (§10).**
7. **AWS internet egress price.** Not present in the S3 region price list (which only shows AWS-internal transfer at $0). The ~$0.09/GB figure is from memory, not verified here.
8. **Temporal Cloud namespace retention default** (assumed 30 days for the workflow-id dedupe window in §4). Verify against your namespace settings.
9. **Meta webhooks for ad-account/ad-review events.** Whether a push channel exists for `effective_status` transitions (which would remove a lot of polling) was not investigated. Worth checking — it would materially reduce the poll-heavy cost profile that drove the orchestrator choice.
10. **Restate Cloud pricing.** Not retrieved. The OSS server is free to self-host; the managed offering's cost is unknown.
11. **Error codes 270, 341 (partially), 368 (partially), 613, 2635, 80000-80014** are documented on the rate-limiting page but not in the Marketing API error reference; the retryability classification in §3.3 for those rows is inferred from the rate-limiting doc plus Airbyte's production code, not from a single authoritative error table.
12. **Whether `GET /act_{id}/campaigns` accepts a `filtering` param.** The SDK's `param_types` for that edge lists only `date_preset`, `effective_status`, `is_completed`, `time_range`. The `*bylabels` edges are used in §4 precisely because label-based reconciliation is verified and name-based filtering is not.

---

## 15. Source index

**Meta — documentation**
- Graph API changelog / version table — <https://developers.facebook.com/docs/graph-api/changelog/>
- Graph API rate limiting (headers, formulas, error codes) — <https://developers.facebook.com/docs/graph-api/overview/rate-limiting>
- Marketing API rate limiting (tiers, QPS, scores) — <https://developers.facebook.com/docs/marketing-api/overview/rate-limiting>
- Graph API error handling — <https://developers.facebook.com/docs/graph-api/guides/error-handling>
- Marketing API error reference — <https://developers.facebook.com/docs/marketing-api/error-reference/>
- Batch requests — <https://developers.facebook.com/docs/graph-api/batch-requests>
- Async ad request sets — <https://developers.facebook.com/docs/marketing-api/asyncrequests/>
- Insights best practices (async job flow) — <https://developers.facebook.com/docs/marketing-api/insights/best-practices>
- Insights overview — <https://developers.facebook.com/docs/marketing-api/insights>
- Campaign create reference — <https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns/>
- Ad set reference — <https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/>
- AdCreative reference — <https://developers.facebook.com/docs/marketing-api/reference/ad-creative/>
- AdVideo edge reference — <https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/>
- Resumable Upload API — <https://developers.facebook.com/docs/graph-api/guides/upload>
- Marketing API access tiers — <https://developers.facebook.com/docs/marketing-api/access>
- System users — <https://developers.facebook.com/docs/marketing-api/system-users>
- Facebook Login for Business — <https://developers.facebook.com/docs/facebook-login/facebook-login-for-business>
- Business Verification — <https://developers.facebook.com/docs/development/release/business-verification>
- Meta Platform Terms — <https://developers.facebook.com/terms/>

**Meta — SDK codegen (exact field names / enums, v26.0.1)**
- `apiconfig.py`, `api.py`, `exceptions.py`, `video_uploader.py`
- `adobjects/`: `adaccount.py`, `campaign.py`, `adset.py`, `ad.py`, `adcreative.py`, `adimage.py`, `advideo.py`, `adsinsights.py`, `adrule.py`, `application.py`
- Base: <https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/>
- Node: <https://raw.githubusercontent.com/facebook/facebook-nodejs-business-sdk/main/src/api.js>, `.../main/package.json`

**Package registries (retrieved 2026-09-02)**
- <https://pypi.org/pypi/facebook-business/json>
- <https://registry.npmjs.org/facebook-nodejs-business-sdk>
- npm `latest` for `bullmq` 6.3.4, `inngest` 4.18.1, `@trigger.dev/sdk` 4.5.15, `@temporalio/client` 1.23.0, `@restatedev/restate-sdk` 1.17.0
- PyPI `latest` for `celery` 5.6.3, `temporalio` 1.32.0, `inngest` 0.5.19, `restate-sdk` 1.0.5

**Orchestration**
- Temporal timers — <https://docs.temporal.io/develop/typescript/timers>
- Temporal workflow limits — <https://docs.temporal.io/workflow-execution/limits>
- Temporal workflow id / reuse & conflict policies — <https://docs.temporal.io/workflow-execution/workflowid-runid>
- Temporal Cloud pricing — <https://docs.temporal.io/cloud/pricing>
- Inngest sleeps — <https://www.inngest.com/docs/features/inngest-functions/steps-workflows/sleeps>
- Inngest idempotency — <https://www.inngest.com/docs/guides/handling-idempotency>
- Inngest pricing — <https://www.inngest.com/pricing>
- Trigger.dev waits — <https://trigger.dev/docs/wait>
- Trigger.dev pricing — <https://trigger.dev/pricing>
- Restate durable timers — <https://docs.restate.dev/develop/ts/durable-timers>
- Restate invocation semantics / idempotency — <https://docs.restate.dev/services/invocation>
- Step Functions quotas — <https://docs.aws.amazon.com/step-functions/latest/dg/limits-overview.html>
- Step Functions pricing — <https://aws.amazon.com/step-functions/pricing/>

**Storage / crypto pricing**
- Cloudflare R2 — <https://developers.cloudflare.com/r2/pricing/>
- AWS S3 price list API (us-east-1) — <https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json>
- AWS KMS price list API (us-east-1) — <https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/awskms/current/us-east-1/index.json>

**Reference implementations**
- Airbyte connector docs — <https://docs.airbyte.com/integrations/sources/facebook-marketing>
- Airbyte rate-limit governor — <https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-facebook-marketing/source_facebook_marketing/api.py>
- Airbyte retry classification — <https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-facebook-marketing/source_facebook_marketing/streams/common.py>
- OTel GenAI semconv — <https://github.com/open-telemetry/semantic-conventions-genai>
- Meta Ads MCP — <https://github.com/pipeboard-co/meta-ads-mcp>
