# Meta Ads Insights API, Attribution & Measurement — Engineering Dossier

**Compiled:** 2026-09-02
**Scope:** how an autonomous ad platform reads performance back from Meta accurately, and what will silently corrupt those reads.
**Baseline version:** Graph API / Marketing API **v26.0** (released 2026-07-29).

> Every non-obvious claim below carries a source URL. Where a fact could not be verified against official docs it is marked **UNVERIFIED** or **verified-secondary**. Assume anything unmarked was read directly off `developers.facebook.com` in September 2026.

---

## 0. Version baseline and the version-expiry trap

| Fact | Value | Source |
|---|---|---|
| Newest Graph API version | **v26.0**, released **2026-07-29**, expiry TBD | https://developers.facebook.com/docs/graph-api/changelog/versions/ |
| Previous Graph versions still alive | v25.0 (exp. 2028-07-29), v24.0 (exp. 2028-02-18), v23.0 (exp. 2027-10-08), v22.0 (exp. 2027-05-20), v21.0 (exp. 2027-01-21), v20.0 (exp. **2026-09-24**) | same |
| Marketing API version lifetime | *"When a new version of the Marketing API releases, Meta continues to support the previous version of the Marketing API for at least 90 days."* Versions ship roughly every 4 months. | https://developers.facebook.com/docs/marketing-api/versions/ |
| Marketing API v23.0 | released 2025-05-29, **expired 2026-06-09** | https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog |
| Marketing API v24.0 | released 2025-10-08, **expires 2026-10-06** | same |
| Official SDK pin | `facebook-python-business-sdk` `apiconfig.py` → `API_VERSION: 'v26.0'`, `SDK_VERSION: 'v26.0.1'` | https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/apiconfig.py |

**Critical difference from Graph API:** *Marketing API* versions expire on a ~12-month clock, far faster than the Graph API's ~24 months. A Graph endpoint may still answer on v22 while the Marketing endpoints on that same version are already dead. Pin the version string in one config constant, add a monthly job that diffs `/docs/graph-api/changelog/versions/` and fails loudly ≥60 days before expiry.

**Expired-version behaviour:** since May 2024 an expired version does not always hard-fail; calls may be **auto-upgraded to the next available version**, which silently changes field semantics under you (source: Marketing API versions page, above). Never rely on "it still returns 200" as proof your version is supported — read `X-Ad-Api-Version-Warning`/deprecation notices and log the effective version.

**Marketing API v26.0 — resolved (fact-check 2026-09-02):** Marketing API v26.0 **does exist**; the v26 launch blog announces both Graph API v26.0 and Marketing API v26.0 with a **2026-07-29** release date. The Marketing API changelog page is simply **stale** — it still shows v25.0 (rel. 2026-02-18) as newest and does not list v26.0 at all. It does, however, confirm the two expiry dates in the table above: v23.0 rel. 2025-05-29 / exp. 2026-06-09 and v24.0 rel. 2025-10-08 / exp. **2026-10-06 — five weeks from this document's date.** Anything still pinned to Marketing API v24.0 breaks (or silently auto-upgrades) in early October 2026. Sources: https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/ , https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog

**Auto-upgrade, exact wording (fact-check 2026-09-02):** *"Starting May 2024, Meta enables the auto-version upgrade feature for Marketing API endpoints that are not affected between versions."* Two things the original draft understated: the auto-upgrade applies only to endpoints **unaffected** between versions (affected endpoints still hard-fail, so an expired pin gives you a *partial* outage that is harder to diagnose than a clean one), and **the feature can be disabled in your app settings** — which is the safer choice for an autonomous system, because a loud failure beats silently shifted semantics. Source: https://developers.facebook.com/docs/marketing-api/versions/

**Doc-site note:** Meta is migrating docs from `developers.facebook.com/docs/marketing-api/...` to `developers.facebook.com/documentation/ads-commerce/marketing-api/...`. Several old `/docs/...` reference URLs now 404 (e.g. `/docs/marketing-api/reference/ads-insights/`, `/docs/marketing-api/insights/parameters`). The `/documentation/ads-commerce/...` tree is the live one. The old `/docs/marketing-api/insights/breakdowns/` and `/docs/marketing-api/out-of-cycle-changes/occ-2025/` still resolve.

---

## 1. `GET|POST /{object_id}/insights` — endpoint anatomy

### 1.1 Objects that expose the edge

```
GET /v26.0/act_{ad_account_id}/insights
GET /v26.0/{campaign_id}/insights
GET /v26.0/{adset_id}/insights
GET /v26.0/{ad_id}/insights
```
Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights

Requires a registered app and the **`ads_read`** permission (`ads_management` implies it). Base URL `https://graph.facebook.com/v26.0/`.

`level` and the node you call are **orthogonal**: calling `act_X/insights?level=ad` returns one row per ad in the account; calling `{campaign_id}/insights?level=ad` returns one row per ad in that campaign. For an autonomous system, **always query the account node with `level=ad` and `time_increment=1`** and shard by date — one request replaces N per-ad requests and burns far less of the insights quota.

### 1.2 Complete parameter set (v26.0)

Verified against the v26.0 SDK's `param_types` for `AdAccount.get_insights` (https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/adaccount.py) and the reference page https://developers.facebook.com/documentation/ads-commerce/graph-api/reference/adgroup/insights:

| Parameter | Type | Notes |
|---|---|---|
| `action_attribution_windows` | `list<enum>` | default `default`. See §4. |
| `action_breakdowns` | `list<enum>` | default `[action_type]` |
| `action_report_time` | `enum` | `impression \| conversion \| mixed \| lifetime` — **ignored since 2025-06-10**, see §4.3 |
| `breakdowns` | `list<enum>` | see §3 |
| `date_preset` | `enum` | default `last_30d` |
| `default_summary` | `bool` | |
| `export_columns` / `export_format` / `export_name` | `list<string>` / `string` / `string` | CSV/XLS export path; not usable programmatically without a user session in practice |
| `fields` | `list<string>` | metrics; see §2 |
| `filtering` | `list<Object>` | see §1.5 |
| `graph_cache` | `bool` | present in SDK, undocumented |
| `level` | `enum` | `ad \| adset \| campaign \| account` |
| `limit` | `int` | page size |
| `product_id_limit` | `int` | caps rows when using `product_id` breakdown |
| `sort` | `list<string>` | one element; `<field>_ascending` / `<field>_descending` |
| `summary` | `list<string>` | fields to also return aggregated in a `summary` object |
| `summary_action_breakdowns` | `list<enum>` | default `[action_type]` |
| `time_increment` | `string` | `monthly \| all_days \| <int>` |
| `time_range` | `map` | `{"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}` |
| `time_ranges` | `list<map>` | multiple ranges in one call |
| `use_account_attribution_setting` | `bool` | default `false` |
| `use_unified_attribution_setting` | `bool` | **ignored since 2025-06-10**, see §4.3 |

### 1.3 `date_preset` enum (v26.0, exhaustive)

```
today, yesterday, this_week_mon_today, this_week_sun_today, last_week_mon_sun,
last_week_sun_sat, this_month, last_month, this_quarter, last_quarter,
this_year, last_year, last_3d, last_7d, last_14d, last_28d, last_30d, last_90d,
maximum, data_maximum
```
Source: https://developers.facebook.com/documentation/ads-commerce/graph-api/reference/adgroup/insights and SDK `AdsInsights.DatePreset`.

Notes that cost time:
- **`lifetime` is gone.** Older code and blog posts use `date_preset=lifetime`; the v26 enum has `maximum` and `data_maximum` instead. `maximum` = the maximum window the API will serve (37 months); `data_maximum` = the maximum window for which data exists on that object.
- `last_3d` and `last_28d` are relatively new; `last_28d` is the one that lines up with the 28-day click window.
- All presets are evaluated in the **ad account's timezone**, not UTC and not your server's timezone (§9.4).

### 1.4 `time_range`, `time_ranges`, `time_increment`

- `time_range={"since":"2026-08-01","until":"2026-08-31"}` — `until` is **inclusive**.
- `time_increment=1` yields one row per day, with `date_start == date_stop`. `time_increment=all_days` (default) yields one aggregate row. `time_increment=monthly` yields calendar months.
- Integer `time_increment` is documented as 1–90 on the reference page; the practical accepted range reported by connector implementations is **1–89** (verified-secondary: https://github.com/airbytehq/airbyte/issues/14391). Treat 1, 7 and `monthly` as the only values worth using.
- `time_ranges` (plural) accepts a list of `{since,until}` maps and returns one result set per range — useful for "last 7d vs prior 7d" comparisons in a single call, which halves your quota burn versus two calls.
- Historical floor: **error code 3018**, whose documented message is *"Start date cannot exceed 37 months from current date"* (corrected wording, fact-check 2026-09-02) (source: reference page error table). 37 months is the hard ceiling for *totals*; several fields have tighter ceilings (§3.4).

### 1.5 `filtering`

Array of `{"field": ..., "operator": ..., "value": ...}`. Operator enum (from the reference page):

```
EQUAL, NOT_EQUAL, GREATER_THAN, GREATER_THAN_OR_EQUAL, LESS_THAN,
LESS_THAN_OR_EQUAL, IN_RANGE, NOT_IN_RANGE, CONTAIN, NOT_CONTAIN,
CONTAINS_ANY, CONTAINS_ALL, NOT_CONTAINS_ANY, STEM_MATCH, IN, NOT_IN,
STARTS_WITH, ENDS_WITH, ANY, ALL, AFTER, BEFORE, ON_OR_AFTER, ON_OR_BEFORE,
NONE, TOP
```

Object-status filters use dotted paths, e.g.
```json
filtering=[{"field":"ad.effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]
```
(verified-secondary example: https://magicbrief.com/post/comprehensive-guide-to-the-facebook-ads-reporting-api)

**Why this matters for an autonomous system:** by default the insights edge returns rows only for objects that had delivery in the window, but archived/deleted objects can still appear. Meta's own best-practices page explicitly recommends *"Use filtering to retrieve only objects with data"* as a rate-limit mitigation (https://developers.facebook.com/docs/marketing-api/insights/best-practices/). Filter to `ad.effective_status IN [ACTIVE, PAUSED, ADSET_PAUSED, CAMPAIGN_PAUSED]` when doing daily pulls; do a separate wide sweep weekly to catch deletions.

### 1.6 Response shape and paging

```json
{
  "data": [ { "date_start": "...", "date_stop": "...", "...": "..." } ],
  "paging": { "cursors": { "before": "...", "after": "..." }, "next": "https://..." }
}
```
Cursor paging. `summary` appears as a sibling of `data` when the `summary` param is used. Follow `paging.next` verbatim; do not reconstruct it (the cursor encodes internal state and error 2642 = "Invalid cursor values").

---

## 2. Fields

### 2.1 The full field roster

The v26.0 `AdsInsights` node reference (https://developers.facebook.com/documentation/ads-commerce/graph-api/reference/adgroup/insights) lists **~289 fields**. The machine-readable subset the official SDK will actually type-check is 221 entries in `AdsInsights._field_types` (https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/adsinsights.py). **Use the SDK file as your canonical field list** — it is versioned, diffable, and does not require scraping a 300-row HTML table.

### 2.2 The fields an optimization loop actually needs

Scalar (`numeric string` — parse as decimal, never float-compare):

| Field | Meaning (quoted from the reference where given) |
|---|---|
| `impressions` | "The number of times your ads were on screen." |
| `reach` | "The number of Accounts Center accounts that saw your ads at least once." **De-duplicated — never sum.** |
| `frequency` | "Average number of times each person saw your ad." = impressions/reach within the queried window only |
| `spend` | "The estimated total amount of money you've spent on your campaign, ad set or ad." |
| `clicks` | "The number of clicks on your ads." (all clicks, incl. reactions/expansions) |
| `inline_link_clicks` | link clicks only — the number that matches "Link clicks" in Ads Manager |
| `inline_link_click_ctr` | "The percentage of time Accounts Center accounts saw your ads and performed an inline link click." |
| `ctr` | clicks (all) ÷ impressions × 100 |
| `cpc` | "The average cost for each click (all)." |
| `cpm` | "The average cost for 1,000 impressions." |
| `cpp` | "The average cost to reach 1,000 Accounts Center accounts." |
| `cost_per_inline_link_click` | the CPC number a link-click optimizer should use |
| `unique_clicks`, `unique_ctr`, `unique_link_clicks_ctr`, `cost_per_unique_click` | de-duplicated variants — **13-month retention cap**, see §3.4 |
| `social_spend`, `full_view_impressions`, `thumb_stops`, `dwell_rate`, `dwell_3_sec/5_sec/7_sec` | secondary attention metrics |
| `quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking` | string; see §8 |
| `estimated_ad_recallers`, `estimated_ad_recall_rate` (+ `_lower_bound`/`_upper_bound`) | brand-lift estimates, only on awareness objectives |
| `attribution_setting` | "The default attribution window to be used when attribution result is calculated. Each ad set has its own attribution setting value." — **request this on every call** (§4.5) |
| `optimization_goal`, `objective`, `buying_type` | needed to interpret `results`/`cost_per_result` |
| `date_start`, `date_stop`, `account_currency` | |

Structured (`list<AdsActionStats>`):

`actions`, `action_values`, `conversions`, `conversion_values`, `cost_per_action_type`, `cost_per_conversion`, `cost_per_unique_action_type`, `purchase_roas`, `website_purchase_roas`, `mobile_app_purchase_roas`, `catalog_segment_value_*_roas`, `outbound_clicks`, `outbound_clicks_ctr`, `cost_per_outbound_click`, `video_play_actions`, `video_thruplay_watched_actions`, `cost_per_thruplay`, `video_p25/p50/p75/p95/p100_watched_actions`, `video_avg_time_watched_actions`, `video_30_sec_watched_actions`, `video_continuous_2_sec_watched_actions`, `instant_experience_outbound_clicks`, `interactive_component_tap`.

Histogram (`list<AdsHistogramStats>`): `video_play_curve_actions`, `video_play_retention_0_to_15s_actions`, `video_play_retention_20_to_60s_actions`, `video_play_retention_graph_actions` — these return an array of bucket values and are the **single most useful signal for AI-generated video creative**: they tell you exactly which second the audience drops off, which is directly actionable by a generative re-cut.

`results` / `cost_per_result` / `result_rate` / `objective_results` / `cost_per_objective_result` are `list<AdsInsightsResult>` — the objective-aware "Results" column from Ads Manager. They are convenient but **objective-dependent and schema-unstable**; prefer explicit `actions[action_type=...]` for anything a control loop keys off.

Newer fields worth knowing about (present in the v26.0 reference table): `creative_fatigue_summary` (`list<CreativeFatigueSummary>`), `creative_fatigued_ads`, `creative_diversity_score`, `creative_diversity_label`, `creative_diversity_data`, `opportunity_score_l4`, `attention_events_per_impression`, `attention_events_unq_per_reach`, `landing_page_view_per_link_click`, `purchase_per_landing_page_view`, `actions_per_impression`, `deduping_ratio` / `deduping_1st_source_ratio` / `deduping_2nd_source_ratio` / `deduping_3rd_source_ratio`. The dedup-ratio family is the *in-Insights* view of pixel↔CAPI deduplication (§6.4). **UNVERIFIED:** none of these have published per-field documentation pages; their exact JSON sub-shapes must be discovered empirically against a live account.

### 2.3 Parsing `AdsActionStats`

Every `list<AdsActionStats>` field returns an array of objects keyed by the active `action_breakdowns` plus one value key per requested attribution window. Field set (https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/):

- Breakdown keys: `action_type`, `action_device`, `action_destination`, `action_target_id`, `action_reaction`, `action_video_type`, `action_video_sound`, `action_canvas_component_name`, `action_carousel_card_id`, `action_carousel_card_name`.
- Value keys: `value` ("Default attribution window metric value"), `1d_click`, `1d_view`, **`1d_ev`** ("Metric value of attribution window '1 day after having an engaged view on the ad'"), `7d_click`, `28d_click`, plus `*_all_conversions` / `*_first_conversion` variants, `dda` ("Data-driven attribution model metric"), `inline` ("Conversions occurring on the ad itself"), and `incrementality` / `incrementality_all_conversions` / `incrementality_first_conversion`.
- **Keys the original draft omitted (fact-check 2026-09-02, from the same reference page):** `1d_ev_all_conversions`, `1d_ev_first_conversion`, `1d_sequenced` / `7d_sequenced` / `28d_sequenced`, `custom`, `promoted_product_set_result`, and the breakdown key `action_video_sound` (*"The sound status (on/off) when someone plays your video ad"*).
- `7d_view` / `28d_view` keys still exist in the schema but **return no data since 2026-01-12** (§4.2).

Concrete shape:

```json
"actions": [
  {"action_type": "link_click", "value": "412"},
  {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "37", "1d_click": "31", "7d_click": "37", "1d_view": "4"},
  {"action_type": "omni_purchase", "value": "39"},
  {"action_type": "purchase", "value": "39"}
]
```

**The single biggest parsing mistake:** summing `actions[].value`. The array contains overlapping roll-ups. `purchase` and `omni_purchase` are aggregates over `offsite_conversion.fb_pixel_purchase`, `app_custom_event.fb_mobile_purchase`, `onsite_web_purchase`, `offline_conversion.purchase` etc. Adding them double- or triple-counts. **Pick exactly one action_type per KPI and hard-code it**, e.g. `offsite_conversion.fb_pixel_purchase` for a pixel/CAPI web business, or `omni_purchase` if (and only if) you want the union across web+app+offline+shops.

> **Sourcing downgraded to `verified-secondary` by fact-check 2026-09-02.** The AdsActionStats reference does **not** state that `omni_*` action types aggregate the underlying ones, and it does **not** list a bare `purchase` action_type at all — it documents `offsite_conversion.fb_pixel_purchase`, `app_custom_event.fb_mobile_purchase` and `omni_purchase` only. The double-counting hazard is real and the "pick one action_type" rule is still the right default, but the exact roll-up membership is undocumented: enumerate the distinct `action_type` values on a live account before assuming which ones nest.

Custom conversions appear as `offsite_conversion.custom.<custom_conversion_id>` — you must join to `/act_X/customconversions` to know what they are.

### 2.4 ROAS

`purchase_roas` and `website_purchase_roas` are `list<AdsActionStats>` too:

```json
"purchase_roas": [{"action_type": "omni_purchase", "value": "3.42"}]
```

The value is a **ratio, not a percentage and not a currency amount**. **Sourcing note (fact-check 2026-09-02):** the reference only says *"The total return on ad spend (ROAS) from purchases"* — it does not state the unit, and the `"3.42"` example above is illustrative, not lifted from a Meta page. The ratio reading is near-certain (it matches Ads Manager's ROAS column) but is **verified-secondary**, not verified-official. Assert it with a runtime sanity check the first time you read a live account. It is computed by Meta as attributed conversion value ÷ spend *using the same attribution setting as the row*. If you compute ROAS yourself as `action_values[purchase]/spend`, expect a small mismatch versus `purchase_roas` because the numerator conversion-value dedup rules differ. Pick one and be consistent; do not mix them in the same decision surface.

---

## 3. Breakdowns

Reference: https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/breakdowns (and the still-live https://developers.facebook.com/docs/marketing-api/insights/breakdowns/).

### 3.1 The v26.0 `breakdowns` enum (exhaustive, from SDK `AdsInsights.Breakdowns`)

```
ad_extension_domain, ad_extension_url, ad_format_asset, affiliate_click_region,
affiliate_link_url, age, app_id, body_asset, breakdown_ad_objective,
breakdown_reporting_ad_id, call_to_action_asset, coarse_conversion_value,
comscore_market, conversion_destination, country, creative_automation_asset_id,
creative_relaxation_asset_type, crm_advertiser_l12_territory_ids,
crm_advertiser_subvertical_id, crm_advertiser_vertical_id, crm_ult_advertiser_id,
description_asset, device_platform, dma, existing_post_id, fidelity_type,
flexible_format_asset_type, frequency_value, gen_ai_asset_type, gender,
hourly_stats_aggregated_by_advertiser_time_zone,
hourly_stats_aggregated_by_audience_time_zone, hsid, image_asset,
impression_device, impression_view_time_advertiser_hour_v2,
instagram_ads_follow_type, instagram_ads_instagram_media_product_type,
instagram_ads_time_since_creation_bucket, internal_campaign_id, is_auto_advance,
is_conversion_id_modeled, is_rendered_as_delayed_skip_ad, landing_destination,
link_url_asset, marketing_messages_btn_name, mdsa_landing_destination,
media_asset_url, media_creator, media_destination_url, media_format,
media_origin_url, media_text_content, media_type, mmm, msa_seller_name,
overlap_segment, pa_creator_ig_handle, place_page_id, placement_path,
platform_position, postback_sequence_index, product_brand_breakdown,
product_category_breakdown, product_custom_label_0..4_breakdown,
product_group_content_id_breakdown, product_id, publisher_platform, redownload,
reels_trending_topic, region, rta_ugc_topic, rule_set_id, rule_set_name,
signal_source_bucket, skan_campaign_id, skan_conversion_id, skan_version,
sot_attribution_model_type, sot_attribution_window, sot_channel, sot_event_type,
sot_source, standard_event_content_type, title_asset, user_persona_id,
user_persona_name, video_asset, zip
```

### 3.2 `action_breakdowns` enum (exhaustive, v26.0)

```
action_type (default), action_device, action_destination, action_target_id,
action_reaction, action_video_type, action_video_sound,
action_canvas_component_name, action_carousel_card_id, action_carousel_card_name,
conversion_destination, is_business_ai_assisted, matched_persona_id,
matched_persona_name, signal_source_bucket, standard_event_content_type
```

> *"If `action_breakdowns` parameter is not specified, `action_type` is implicitly added."* — breakdowns doc. So even a request that never mentions `action_breakdowns` gets `action_type` keys in its action arrays.

### 3.3 Legal combinations

Meta publishes an explicit permutation list rather than a rule. The combinations that matter for optimization:

**Single-only (cannot be combined with anything else):** `action_converted_product_id`, `action_reaction`, `action_carousel_card_id` / `action_carousel_card_name` (except with `impression_device`, `country`, `age`, `gender`, `age+gender`).

**Combinable groups** (entries marked `*` in Meta's table can additionally be joined with `action_type`, `action_target_id`, `action_destination`):
```
age *
gender *
age, gender *
country *
region *
publisher_platform *
publisher_platform, platform_position *
publisher_platform, impression_device *
publisher_platform, platform_position, impression_device *
action_device, publisher_platform *
action_device, publisher_platform, platform_position *
action_device, publisher_platform, platform_position, impression_device *
action_device, impression_device *
product_id *
hourly_stats_aggregated_by_advertiser_time_zone *
hourly_stats_aggregated_by_audience_time_zone *
app_id, skan_conversion_id
action_type, action_converted_product_id
action_type, action_reaction
```

**The four that earn their keep for an autonomous optimizer:**
1. `publisher_platform, platform_position` — tells you whether Reels, Feed, Stories or Audience Network is eating the budget. Combined with `device_platform` this is the standard placement-pruning signal.
2. `age, gender` — the only demographic pair that is legal together.
3. `country` — currency-neutral geo pruning (`region` and `dma`/`comscore_market` are much higher cardinality and hit limits fast).
4. `hourly_stats_aggregated_by_advertiser_time_zone` — dayparting. Note it is aggregated by the **advertiser's** timezone, so it lines up with the `date_start` bucket; the `_by_audience_time_zone` variant does not.

### 3.4 Breakdown restrictions that will bite

| Restriction | Detail | Source |
|---|---|---|
| Hourly breakdowns kill unique metrics | *"Hourly breakdowns do not support unique fields, which are any fields prepended with `unique_*`, `reach` or `frequency`."* They return 0 or are omitted. | breakdowns doc |
| Hourly + video | video_* fields cannot be requested with hourly breakdowns | breakdowns doc |
| `region` + video | `video_avg_time_watched_actions` cannot be requested with `region`; `video_p25..p100_watched_actions` do not support `region` | breakdowns doc |
| `dma` gaps | unavailable for `estimated_ad_recall_rate` and `video_thruplay_watched_actions` | breakdowns doc |
| Dynamic-creative asset breakdowns | only `impressions`, `clicks`, `spend`, `reach`, `actions`, `action_values` are returned | breakdowns doc + https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/insights/ |
| Fields that cannot be used with **any** breakdown | `app_store_clicks`, `newsfeed_avg_position`, `newsfeed_clicks`, `newsfeed_impressions`, `relevance_score` | breakdowns doc |
| Off-Meta actions, "type 1" breakdowns | With `region`, `dma`, `hourly_stats_aggregated_by_audience_time_zone`, `hourly_stats_aggregated_by_advertiser_time_zone`: *"The Insights API will not return unsupported off-Meta metrics"* — i.e. your web purchases silently vanish | breakdowns doc |
| Off-Meta actions, "type 2" breakdowns | With `action_device`, `action_destination`, `action_target_id`, `product_id`, `action_carousel_card_*`, `action_canvas_component_name`: *"Off-Meta web metrics will continue to be returned … however will not contain the breakdown value. The mobile metrics will not be returned anymore."* | breakdowns doc |
| `reach` + breakdowns + old dates | Since **2025-06-10**, `reach` is not returned for *standard* (sync) queries applying breakdowns with `start_date` >13 months old. Async jobs may still serve it, limited to **10 requests per ad account per day**. | https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2025/ |
| Unique-count fields | **13-month** retention cap since 2026-01-12 (`unique_actions`, `cost_per_unique_action_type`, all `unique_*`) | https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/ |
| Hourly breakdowns | **13-month** retention cap since 2026-01-12 | same |
| `frequency_value` breakdown | **6-month** retention cap since 2026-01-12 | same |
| `mmm` breakdown | **async jobs only** since 2026-01-12 | same |
| Totals | *"total values for API fields are unaffected by the above changes and will continue to be available for up to 37 months."* | same |

### 3.5 Two 2026 breakdown changes you must code around

**(a) `dma` is dead — effective 2026-06-22.**
> *"Effective June 22, 2026, we are transitioning from Nielsen Designated Market Areas (DMAs) to Comscore Markets across ads targeting and reporting solutions. When requesting market-level data via the Ads Insights API, `breakdowns=dma` will no longer be supported; to retrieve market-level data, please instead use `breakdowns=comscore_market`."*
Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026
**Doc-staleness warning (fact-check 2026-09-02):** the breakdowns reference at https://developers.facebook.com/docs/marketing-api/insights/breakdowns/ has **not** been updated for this change — it still documents `dma` (including its sampling methodology and its gaps for `estimated_ad_recall_rate` / `video_thruplay_watched_actions`) and contains **no mention of `comscore_market` at all**. Do not treat that page as authoritative for post-June-2026 geo reporting; OCC 2026 wins. Corollary: `comscore_market`'s legal breakdown combinations are currently **undocumented** — probe them.

**(b) Three breakdowns became opt-in — effective 2026-08-06.**
> *"Beginning August 6, 2026, the following Ads Insights API breakdowns will require opt-in for certain ad accounts: 1. `breakdowns=impression_device` (including any combination that contains `impression_device`) 2. `breakdowns=hourly_stats_aggregated_by_audience_time_zone` 3. `breakdowns=frequency_value`"*
> *"Synchronous API requests using these breakdowns may return no results for ad accounts that have not opted in… Asynchronous report jobs remain available for all your history as long as you opted in."*
Opt-in is **manual**: *"Account administrators can request access to these breakdowns directly in Ads Manager."* Verbatim on scope: *"This applies to non-sales-supported accounts only; sales-supported accounts are unaffected."*
**Added by fact-check 2026-09-02:** the same entry throttles asynchronous jobs using these breakdowns to **`min(10, number_of_ad_groups)` per 24 hours**. For an account with 4 ad sets that is 4 async jobs/day, not 10 — schedule backfills off the ad-group count, not a flat 10.
Source: same OCC 2026 page.

**Design consequence:** a fully autonomous platform onboarding arbitrary client ad accounts **cannot self-serve `impression_device` or `frequency_value`**. Either (i) treat them as optional enrichment that degrades to null, or (ii) add a one-time human checklist item during account onboarding. Do not build placement logic that hard-depends on `impression_device`; use `device_platform` + `platform_position`, which are not gated.

### 3.6 Creative-level analysis — the real limitation

This is where most creative-optimization ambitions break.

- **Per-ad is the reliable unit.** `level=ad` gives clean per-creative numbers as long as one ad = one creative. If your generator produces N videos, ship them as N ads, not as one flexible/Advantage+ ad with N assets. This is the single most important architectural decision in the whole measurement design.
- **Asset breakdowns exist but are crippled.** `body_asset`, `title_asset`, `description_asset`, `image_asset`, `video_asset`, `call_to_action_asset`, `link_url_asset`, `ad_format_asset` return only `impressions`, `clicks`, `spend`, `reach`, `actions`, `action_values`, and can only be combined with `age`/`gender`. No ROAS field, no video-retention curve, no ranking diagnostics, no CPA-by-attribution-window. Response shape:
  ```json
  {"body_asset": {"text": "Test text", "id": "6051732675652"}, "impressions": "8801", "date_start": "2016-04-29", "date_stop": "2016-05-13"}
  ```
  Source: https://developers.facebook.com/docs/marketing-api/insights/breakdowns/ (six-field list) — **but the two doc pages disagree (fact-check 2026-09-02):** https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/insights/ lists only *"actions, clicks, impressions"* plus derived `ctr` / `actions_per_impressions`, i.e. **no `spend`, `reach` or `action_values`**. Take the intersection (`impressions`, `clicks`, `actions`) as what you can rely on, and probe `spend`/`reach`/`action_values` before depending on them. Both pages agree the only legal companion breakdowns are `age`, `gender`, or `age, gender`.
- **Asset attribution is not causal.** Because Meta's delivery system chooses which asset to show, per-asset numbers are confounded by selection: the "winning" asset was shown to the users Meta already believed would convert. Asset-level data can rank creatives *within* an ad but must not be used as an unbiased creative test.
- **Creative breakdown (2025-07-11 rollout)** covers flexible-format ads (up to 10 images/videos) and Advantage+ AI-generated image variants; it explicitly **excludes dynamic creative ads**, disables bar/trend chart views, and only covers data from 2017-07-01 onward (verified-secondary: https://ppc.land/meta-unveils-creative-breakdown-for-flexible-formats-and-ai-generated-image-ads/). The v26.0 breakdown enum contains the API-side counterparts — `flexible_format_asset_type`, `gen_ai_asset_type`, `creative_automation_asset_id`, `creative_relaxation_asset_type`, `media_asset_url`, `media_type`, `media_format`, `media_text_content`, `breakdown_reporting_ad_id` — but **UNVERIFIED:** none of these have published documentation pages describing their returned values or legal combinations. Probe them empirically before depending on them.

---

## 4. Attribution — the part that changed most

### 4.1 `action_attribution_windows` enum (v26.0, exhaustive)

From SDK `AdsInsights.ActionAttributionWindows`:
```
default, 1d_click, 7d_click, 28d_click, 1d_view, 7d_view, 28d_view, 1d_ev,
1d_sequenced, 7d_sequenced, 28d_sequenced,
7d_view_first_conversion, 28d_view_first_conversion,
7d_view_all_conversions, 28d_view_all_conversions,
dda, custom,
incrementality, incrementality_all_conversions, incrementality_first_conversion,
skan_view, skan_click, skan_click_second_postback, skan_view_second_postback,
skan_click_third_postback, skan_view_third_postback
```
Default: `default`.

### 4.2 What is actually alive (as of 2026-09)

Announced 2025-10-13/16, **effective 2026-01-12**:
> *"Data for 7-day view-through (`action_attribution_windows=7d_view`) and 28-day view-through (`action_attribution_windows=28d_view`) attribution windows will no longer be available and will return no data"*
Source: https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/ and https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2025/

**Surviving windows:** `1d_click`, `7d_click`, `28d_click`, `1d_view`, `1d_ev` (1-day engaged view).

The enum values `7d_view`/`28d_view` were *not removed from the schema*; they are accepted and return **zeros / absent keys**. A naive system that requests them will not error — it will just quietly report a fraction of the truth. Reported conversions dropped **15–40 %** overnight for advertisers who had view-heavy attribution (verified-secondary: https://seresa.io/blog/attribution-measurement/meta-killed-its-28-day-view-attribution-window-on-january-12-2026, https://ppc.land/meta-restricts-attribution-windows-and-data-retention-in-ads-insights-api/). **Do not compare pre- and post-2026-01-12 conversion history without a regime flag.**

### 4.3 The 2025-06-10 behaviour change: two parameters silently stopped working

> *"On June 10, 2025, Ads Insights API behavior will change in two ways: To reduce discrepancies with Meta Ads Manager, `use_unified_attribution_setting` and `action_report_time` parameters will be disregarded, and API responses will mimic Meta Ads Manager settings."*
Source: https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2025/ (March 10, 2025 entry)

**Source correction (fact-check 2026-09-02):** the OCC 2025 entry contains *only* the two-bullet sentence above — it does **not** describe the resulting behaviour, and its inline link to `…/marketing-api/insights#discrepancy-with-ads-manager` is a **dead anchor** (no such section renders). The expanded behaviour below is verbatim from the **Insights best-practices page** (https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/best-practices) — cite that, not OCC 2025:

> *"Attributed `value`s will be based on ad set level attribution settings (similar to `use_unified_attribution_setting=true`)"*
> *"standalone `inline` attribution window data will no longer be returned."*
> *"Actions will be reported using `action_report_time=mixed`: on-Meta actions (e.g., Link Clicks) will use impression-based reporting time; whereas off-Meta actions (e.g., Web Purchases) will leverage conversion-based reporting time."*

Restated:
- Attributed values are **based on ad-set-level attribution settings**, i.e. behaviour equivalent to the old `use_unified_attribution_setting=true`.
- **Inline / on-ad actions are folded into `1d_click` or `1d_view`.** *"After this change, standalone inline attribution window data will no longer be returned."* The `inline` key in `AdsActionStats` is therefore vestigial.
- Actions are reported as if `action_report_time=mixed`: **on-Meta actions (link clicks, video views) use impression time; off-Meta actions (web purchases) use conversion time.**

This is the most consequential and least-known change in the whole API. Consequences:

1. **Every attribution-window comparison table you build is now hybrid.** Your `spend` for 2026-08-01 is impression-dated, and your web `purchase` count for 2026-08-01 is *conversion*-dated. So a same-row "ROAS on 2026-08-01" mixes two different date semantics. This is exactly how Ads Manager behaves, so at least the two agree — but it means **daily ROAS is not a clean cohort metric.** If you need true cohort economics (spend on day D vs conversions *caused by* day D's spend), the Insights API cannot give it to you post-2025-06-10; you must reconstruct it from CAPI-side data or accept the hybrid.
2. Any code still passing `use_unified_attribution_setting=true` "to match Ads Manager" is now a no-op. Harmless, but delete it so nobody believes it's load-bearing.
3. `use_account_attribution_setting` (default `false`) is a *different* parameter and, as far as the docs say, still functional. **UNVERIFIED:** whether it too is now redundant given ad-set settings are used by default. Test empirically.

### 4.4 Engage-through: the newest wrinkle

Announced by Meta Business (https://www.facebook.com/business/news/click-attribution), rolling out from **March 2026** for campaigns optimizing toward website or in-store conversions:

- **Click-through attribution was narrowed to link clicks only.** Shares, saves, likes and comments no longer count as "clicks" for conversion attribution.
- Those non-link interactions moved into **engage-through attribution** (the renamed "engaged-view"), which in the API is the **`1d_ev`** window — *"Metric value of attribution window '1 day after having an engaged view on the ad'"* (https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/).
- The **video engaged-view threshold dropped from 10 seconds to 5 seconds**.
- No billing impact; rollout timing varies per advertiser.

Practical default setting now reported for conversion campaigns: **7-day click, 1-day engage-through, 1-day view** (verified-secondary: https://www.dataslayer.ai/blog/meta-attribution-change-2026-what-engage-through-attribution-is-and-why-your-numbers-look-different, https://jetfuel.agency/meta-ads-attribution-settings-2026/). **UNVERIFIED against official docs** — Meta's own help-centre pages (facebook.com/business/help/*) are JS-rendered and could not be fetched programmatically; verify by reading `attribution_setting` off a live ad set.

**Implication:** if your ROAS model was calibrated on pre-March-2026 data where engagement clicks counted as clicks, `7d_click` conversions dropped and `1d_ev` conversions appeared. Sum `7d_click + 1d_ev + 1d_view` if you want continuity with the old "click + view" total; report `7d_click` alone if you want the strictest, most causal-looking number.

### 4.5 `attribution_setting` — request it on every call

`attribution_setting` (string) is an insights **field**, not a parameter: *"The default attribution window to be used when attribution result is calculated. Each ad set has its own attribution setting value. **The attribution setting for campaign or account is calculated based on existing ad sets.**"* (final sentence restored by fact-check 2026-09-02 — it means a campaign- or account-level row's `attribution_setting` is a *derived* value, so it can be meaningless when child ad sets disagree). Because rows are now attributed using the ad set's own setting, **two rows in the same response can be attributed differently**. Aggregating them into an account-level ROAS is only valid if every ad set shares a setting.

Rules for the platform:
- Always add `attribution_setting` to `fields`.
- Refuse to aggregate across rows with differing `attribution_setting` unless you also requested explicit `action_attribution_windows` and are reading a specific window key (e.g. `7d_click`), which is attribution-setting independent.
- Set `attribution_spec` explicitly at ad-set creation so the whole account is homogeneous. `attribution_spec` is `list<AttributionSpec>` with `event_type`, `window_days`, `weight`: *"Conversion attribution spec used for attributing conversions for optimization. Supported window lengths differ by optimization goal and campaign objective."* (https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-campaign). Example: `[{"event_type":"CLICK_THROUGH","window_days":7},{"event_type":"VIEW_THROUGH","window_days":1}]`.

### 4.6 iOS / ATT and Aggregated Event Measurement

- Under ATT, events from iOS 14.5+ users who declined tracking are processed through **Aggregated Event Measurement (AEM)**, a privacy-preserving aggregation protocol.
- **8 event slots per domain.** *"You will be limited to the use of 8 conversion events per domain (i.e., 8 <pixel, event> or <custom conversion> per domain) for campaign optimization."* For app events: *"There are 8 event slots… Each event uses one event slot except for purchase events with value optimization turned on, which use a minimum of 4 event slots."*
  Sources: https://www.facebook.com/business/help/721422165168355, https://developers.facebook.com/documentation/app-events/guides/aggregated-event-measurement
- **Domain verification is a prerequisite** for configuring the 8 events.
- Practical effects on the read path:
  - AEM data arrives **delayed and aggregated**; it can appear up to ~72h late and is not attributable to individual users.
  - The breakdown `is_conversion_id_modeled` exists precisely to flag modelled conversions.
  - `skan_*` breakdowns and `skan_*` attribution windows are the SKAdNetwork path for app installs; irrelevant for web.
  - View-through on iOS is heavily suppressed, which compounds the 2026-01-12 removal of 7d/28d view.

**Design consequence:** a fully autonomous platform must, at account-onboarding time, verify the domain and pick the 8 AEM events. That is a hard human/manual gate (Events Manager UI) — see §11.

---

## 5. Data freshness, settling, and the "don't judge day-1" rule

### 5.1 What Meta actually commits to

> *"Insights refresh every 15 minutes and do not change after 28 days of being reported"*
Source: https://developers.facebook.com/docs/marketing-api/insights/best-practices/

Read that carefully — it is two statements:
1. The **write cadence** is ~15 minutes. Polling more often than every 15 minutes is pure quota waste.
2. A given `date_start` row **remains mutable for 28 days**. This is a direct consequence of the 28-day click window: a click on day D that converts on day D+27 is retro-attributed to D.

### 5.2 The stabilization model to implement

| Age of the row | State | What you may do with it |
|---|---|---|
| 0–4 h | Delivery only. Impressions/spend approximately real; conversions barely populated. | Nothing. Do not evaluate. |
| < 24 h ("today") | Partial day in the account's timezone; `spend` under-reports; off-Meta conversions lag most. | Safety checks only (runaway spend, zero-delivery, disapproval). Never CPA/ROAS decisions. |
| 1–3 days | Most `1d_click` and `1d_ev` conversions in; `7d_click` incomplete. | Directional only. Kill decisions require a very large effect size. |
| 3–7 days | `1d_*` windows effectively final. `7d_click` ~complete by D+7. | **The practical decision window** for a `7d_click`-attributed account. |
| 7–28 days | Only long-tail `28d_click` still moving. | Final for `7d_click` accounts; still drifting for `28d_click` accounts. |
| > 28 days | Frozen by Meta's own statement. | Safe for backfills, model training, financial reconciliation. |

**Concrete rules for the autonomous loop:**
- Never take a kill/scale action on a row whose `date_stop` is within `attribution_click_window_days` of now, unless the decision is a *guardrail* (spend > cap, `effective_status` in `{DISAPPROVED, WITH_ISSUES}`, zero impressions after N hours).
- Re-fetch a **rolling 28-day window** on every sync and upsert by `(date_start, ad_id, breakdown_key…)`. Anything less and your warehouse permanently under-reports conversions. A rolling 7-day re-fetch is the commonest under-specification and it costs 5–15 % of reported conversions.
- Freeze rows older than 28 days into an immutable partition; stop re-fetching them (this is also your biggest quota saving).
- Store the `attribution_setting` and an `attribution_regime` version stamp on every row so the 2026-01-12 and March-2026 discontinuities are queryable rather than mysterious.

### 5.3 Statistical stabilization, separate from data settling

Data settling is not the same as statistical significance. An ad with 3 conversions is not evaluable no matter how settled the row is. A workable gate before any spend-reallocation decision:
- ≥ 1 000 impressions (also the floor for ranking diagnostics — §8),
- ≥ 3 days of delivery since last significant edit,
- ≥ 50 optimization events at ad-set level *or* an explicit low-volume mode that optimizes on an upper-funnel proxy (link clicks, landing-page views, `landing_page_view_per_link_click`) instead of purchases.

---

## 6. Learning phase — reading it from the API

### 6.1 The rule

The ad set must accumulate **~50 optimization events within a 7-day window since the last significant edit** to exit learning. Meta's own help copy: *"…wait until your ad set has generated about 50 optimization events since your last significant edit, which indicates that your current costs are more stable"* (https://www.facebook.com/business/help/112167992830700/, surfaced via search; the page is JS-rendered and could not be fetched directly — **verified-secondary**).

If the ad set cannot reach ~50 events in 7 days, it is flagged **"Learning Limited"** and delivery/costs stay unstable.

### 6.2 The API surface

`learning_stage_info` on the **ad set** node — type `AdCampaignLearningStageInfo`:
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-learning-stage-info/

| Field | Type | Description (verbatim) |
|---|---|---|
| `status` | enum | *"Learning Phase progress for the ad set."* — **`LEARNING`** ("The ad set is still learning"), **`SUCCESS`** ("The ad set exited the learning phase"), **`FAIL`** ("The ad set isn't generating enough results to exit the learning phase") |
| `conversions` | unsigned int | *"Number of conversions the ad set generated since the time of its last significant edit during the learning phase."* |
| `last_sig_edit_ts` | integer | *"Timestamp of the last significant edit that caused ad set to reenter the learning phase."* |
| `attribution_windows` | list<enum> | *"Number of days between when a person viewed or clicked your ad and subsequently took action."* |
| `dynamic_lp_status` | enum | dynamic learning-phase status |
| `dynamic_lp_conversions_threshold` | unsigned int | *"New conversions threshold for dynamic learning phase status"* |
| `dynamic_lp_days_threshold` | unsigned int | *"Day to exit for dynamic learning phase"* |

**`status=FAIL` is the API's name for "Learning Limited".** There is no separate `LEARNING_LIMITED` enum value. This is the single most useful line in this document for an autonomous system: read `learning_stage_info{status,conversions,last_sig_edit_ts}` on every ad set on every sync.

**`dynamic_lp_*` is newer and important:** Meta now publishes a *per-ad-set* conversions threshold and days threshold rather than a universal 50/7. Prefer `dynamic_lp_conversions_threshold` over the hard-coded 50 when it is populated; fall back to 50 when null. **UNVERIFIED:** the `dynamic_lp_status` enum values are not documented.

Example request:
```
GET /v26.0/act_{id}/adsets
  ?fields=id,name,effective_status,configured_status,optimization_goal,bid_strategy,
          daily_budget,attribution_spec,
          learning_stage_info{status,conversions,last_sig_edit_ts,
                              dynamic_lp_status,dynamic_lp_conversions_threshold,
                              dynamic_lp_days_threshold},
          issues_info{error_code,error_message,error_summary,error_type,level},
          recommendations
```

### 6.3 Status fields and delivery diagnostics

**Ad-level `effective_status` enum** (SDK `Ad.EffectiveStatus`, v26.0):
```
ACTIVE, PAUSED, DELETED, ARCHIVED, ADSET_PAUSED, CAMPAIGN_PAUSED,
DISAPPROVED, PENDING_REVIEW, PREAPPROVED, PENDING_BILLING_INFO,
IN_PROCESS, WITH_ISSUES
```
**Ad-set-level `effective_status`:** `ACTIVE, PAUSED, DELETED, CAMPAIGN_PAUSED, ARCHIVED, IN_PROCESS, WITH_ISSUES`.
`configured_status` / `status` are always the plain four: `ACTIVE, PAUSED, DELETED, ARCHIVED`.
Sources: SDK `ad.py`; https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-campaign

`configured_status` is *what you set*; `effective_status` is *what Meta is doing*. An autonomous system must key delivery health off `effective_status` — a `configured_status=ACTIVE` ad with `effective_status=DISAPPROVED` spends nothing and will look like "zero conversions" to a naive optimizer, which will then "learn" that the creative is bad.

`issues_info` (`list<AdCampaignIssuesInfo>`), described as *"Issues for this ad set that prevented it from delivering"*, fields: `error_code` (int32), `error_message`, `error_summary`, `error_type`, `level` ("Indicate level of issue, could be ad set or campaign"). Documented example codes: `2460003` (blocked custom audiences), `2460004` (blocked custom conversions).
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-issues-info/
**UNVERIFIED:** there is no published exhaustive enum of `error_code`/`error_type` values for `issues_info`. Treat it as free-form and log everything; build the taxonomy from your own corpus.

`recommendations` (`list<AdRecommendation>`): *"If there are recommendations for this ad set, this field includes them. Otherwise, will not be included in the response."* Note the "otherwise not included" — absence of the key is meaningful, do not treat it as an error. The `lift_estimate` field inside recommendations was upgraded 2026-05-04 to *"incorporate a new data source to provide personalized insights for eligible campaigns"* (OCC 2026).

### 6.4 Which edits reset learning

Meta calls these **significant edits**. Per the help centre (verified-secondary — JS-rendered pages, surfaced via search of https://www.facebook.com/business/help/316478108955072 and /942374239243867): a significant edit is a change to **targeting/audience, creative, optimization event, placement, bid strategy or bid amount**, and **pausing the ad set** (an ad set paused ≥7 days re-enters learning on resume). Budget changes are significant when large — the widely used practical rule is that a change over roughly ±20 % re-triggers learning, but **UNVERIFIED**: Meta does not publish a numeric budget threshold.

**Design consequences for a self-improving system:**
- Do not implement continuous small budget nudges. Batch budget changes into at most one adjustment per ad set per 3–4 days, and keep each step within a conservative band (≤20 %).
- Prefer **adding a new ad** to an existing ad set over **editing** an existing ad's creative — editing creative is a significant edit at the ad level and can disturb the ad set.
- Use `last_sig_edit_ts` as the origin for every performance evaluation window. Evaluating an ad set over "last 7 days" when `last_sig_edit_ts` was 2 days ago mixes two delivery regimes.
- Prefer campaign-level budget (Advantage Campaign Budget / CBO) so the reinforcement loop can shift money between ad sets without editing ad-set budgets at all.

---

## 7. Async report jobs

### 7.1 The flow

Source: https://developers.facebook.com/docs/marketing-api/insights/best-practices/ (and the ads-commerce mirror).

**Step 1 — submit (POST, not GET):**
```bash
curl -F 'level=campaign' \
     -F 'fields=campaign_id,spend,impressions,actions' \
     -F 'time_range={"since":"2026-08-01","until":"2026-08-31"}' \
     -F 'time_increment=1' \
     -F 'access_token=<TOKEN>' \
     https://graph.facebook.com/v26.0/<AD_OBJECT_ID>/insights
```
Response:
```json
{"report_run_id": "6023920149050"}
```
Note: the switch to async is **the HTTP verb**, not an `async=true` parameter. `POST /insights` = async job; `GET /insights` = synchronous. (The Python SDK exposes this as `get_insights_async()` / `is_async=True`, which issues the POST for you.)

**Step 2 — poll the AdReportRun node:**
```bash
curl -G -d 'access_token=<TOKEN>' \
     https://graph.facebook.com/v26.0/<REPORT_RUN_ID>
```
Returns `async_status` and `async_percent_completion`. `async_status` enum:
```
Job Not Started | Job Started | Job Running | Job Completed | Job Failed | Job Skipped
```
(Note: these are human-readable strings **with spaces and title case** — not SCREAMING_SNAKE. String-compare exactly.)
- `Job Failed` → *"Requires query review and resubmission"*.
- `Job Skipped` → *"Expired; resubmit required"*.

**Step 3 — read results:**
```bash
curl -G -d 'access_token=<TOKEN>' \
     https://graph.facebook.com/v26.0/<REPORT_RUN_ID>/insights
```
Then page with `paging.next`.

### 7.2 Rules and gotchas

- **Poll on both conditions.** Meta's own instruction is to poll *"until `async_status` is `Job Completed` and `async_percent_completion` is 100"*. `async_percent_completion` can hit 100 while `async_status` is still `Job Running`; reading `/insights` then returns an empty or partial `data` array with **no error**. This is the classic one-day-of-debugging bug.
- **`report_run_id` expires after 30 days:** *"Do not store the `report_run_id` for long term use, it expires after 30 days."*
- **Runtime:** *"Asynchronous requests can take up to an hour to complete including retry attempts."* Budget for that; do not hold a request thread.
- **Polling cadence:** not specified by Meta. Since insights refresh on a 15-minute cadence anyway, exponential backoff starting at 5–10 s and capping at 60 s is ample; polling every second just burns quota.
- **When async is mandatory (not optional):**
  - `breakdowns=mmm` — async only since 2026-01-12.
  - `reach` with breakdowns and `start_date` > 13 months old — sync returns nothing; async allows **10 requests per ad account per day**.
  - ~~The gated breakdowns of §3.5(b).~~ **CORRECTED (fact-check 2026-09-02):** async is **not** a workaround for a non-opted-in account. OCC 2026 reads *"Asynchronous report jobs remain available for all your history **as long as you opted in**"* — opt-in gates both verbs; async merely preserves full history *after* opt-in. The same entry throttles async jobs on these breakdowns to **`min(10, number_of_ad_groups)` per 24 hours**. Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026
  - Anything large enough that sync times out. Meta's stated order of operations: *"Try sync calls first and then use async calls in cases where sync calls timeout."*
- **UNVERIFIED:** the maximum number of concurrent async jobs per app or per ad account is not documented. Empirically, treat 3–5 concurrent jobs per ad account as a safe ceiling and serialize beyond that.
- Async jobs still consume the ads_insights quota; they are not a rate-limit bypass.

---

## 8. Ranking diagnostics and creative quality signals

### 8.1 The three fields

`quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking` — all `string` type in the v26.0 SDK (`AdsInsights._field_types`). Ad-level only.

Definitions (https://www.facebook.com/business/help/403110480493160, surfaced via search):
- **Quality ranking** — perceived ad quality vs ads competing for the same audience. Signals include feedback from people viewing or hiding the ad, and low-quality attributes (withholding information, sensationalized language, engagement bait).
- **Engagement rate ranking** — expected engagement rate vs ads competing for the same audience.
- **Conversion rate ranking** — expected conversion rate vs ads *with the same optimization goal* competing for the same audience.

Tiers: **Above Average** (>55th percentile), **Average** (35th–55th percentile), **Below Average**, subdivided into bottom 35 %, bottom 20 % and bottom 10 %.

**Availability floor: fewer than 500 impressions → no diagnostics.** (verified-secondary: https://www.facebook.com/business/help/403110480493160 via search; a further secondary source states the metric is only computed over a trailing ~35-day window.)

**UNVERIFIED:** the exact API string values. Community usage and the tier structure strongly imply `ABOVE_AVERAGE`, `AVERAGE`, `BELOW_AVERAGE_35`, `BELOW_AVERAGE_20`, `BELOW_AVERAGE_10`, `UNKNOWN` — but no official enum is published, the SDK types the field as a bare `string`, and no Meta doc page lists them. **Do not `switch` on these values without a default branch**; log any unseen value and fall through to "unknown".

### 8.2 How the diagnostics should drive decisions

The three rankings are a **diagnostic triage matrix**, not a score to optimize. The intended reading (Meta's framing) is: given a high cost per result, which of three causes is it?

| quality | engagement | conversion | Diagnosis | Autonomous action |
|---|---|---|---|---|
| Below | Above/Avg | Above/Avg | Creative is perceived as low quality / clickbait-y, but works | Regenerate creative with cleaner copy; remove sensationalized language, hidden-info hooks, engagement bait. High-value fix for AI-generated creative, which drifts toward clickbait. |
| Above/Avg | Below | Above/Avg | The hook doesn't earn attention | Regenerate the **first 3 seconds** — cross-reference `video_play_curve_actions` / `video_p25_watched_actions ÷ video_play_actions` |
| Above/Avg | Above/Avg | Below | Post-click problem | Landing page / offer / audience mismatch — check `landing_page_view_per_link_click` and `purchase_per_landing_page_view`; do not blame the creative |
| Below | Below | Below | Fundamental mismatch | Kill; do not iterate |
| Above | Above | Above | Working | Scale (respecting §6.4 edit rules) |

**Do not use rankings as a kill trigger on their own.** They are relative to the current auction cohort, so a strong ad in a strong cohort can read "Average". Use CPA/ROAS as the primary objective and rankings only to choose *which repair* to attempt.

### 8.3 Better creative signals than the rankings

For AI-generated video specifically, the highest-information fields are:
- `video_play_curve_actions` / `video_play_retention_graph_actions` — the exact drop-off curve.
- `video_p25_watched_actions ÷ video_play_actions` — hook retention. This is the metric a generative loop can act on directly (re-cut the opening).
- `video_thruplay_watched_actions` and `cost_per_thruplay` — ThruPlay is 15 s or completion, whichever first.
- `thumb_stops` and `dwell_rate` / `dwell_3_sec` — attention proxies (newer, undocumented shape; **UNVERIFIED**).
- `inline_link_click_ctr` for the hook→click transition, then `landing_page_view_per_link_click` for the click→LP transition, then `purchase_per_landing_page_view` for LP→purchase. **This three-ratio funnel localizes the failure far better than any ranking string.**

---

## 9. Conversions API (CAPI)

### 9.1 Why an autonomous system needs it

Browser-only pixel signal is degraded by ATT, ITP/Safari cookie lifetimes, ad blockers and consent gates. Fewer observed conversions means (a) the ad set takes longer to reach ~50 events and is more likely to sit in `learning_stage_info.status = FAIL`, and (b) your own reward signal is noisier. Server-side events restore volume and match quality. For a platform that must self-optimize without a human, CAPI is not optional — it is the difference between a working control loop and one that starves.

### 9.2 Endpoint and payload

```
POST https://graph.facebook.com/v26.0/{DATASET_ID}/events?access_token={TOKEN}
```
(`{DATASET_ID}` and `{PIXEL_ID}` are the same identifier; Meta renamed pixels to datasets and the docs use both.)
Source: https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api/

```json
{
  "data": [
    {
      "event_name": "Purchase",
      "event_time": 1633552688,
      "event_id": "event.id.123",
      "event_source_url": "http://jaspers-market.com/product/123",
      "action_source": "website",
      "user_data": {
        "client_ip_address": "192.19.9.9",
        "client_user_agent": "test ua",
        "em": ["309a0a5c3e211326ae75ca18196d301a9bdbd1a882a4d2569511033da23f0abd"],
        "ph": ["254aa248acb47dd654ca3ea53f48c2c26d641d23d7e2e93a1ec56258df7674c4"]
      },
      "custom_data": { "value": 100.2, "currency": "USD" }
    }
  ],
  "test_event_code": "TEST12345"
}
```

Response: `{"events_received": N, "messages": [...], "fbtrace_id": "..."}`.

**Hard limits (all quoted from the using-the-api page):**
- *"You can send up to 1,000 events in `data`"*.
- *"If any event you send in a batch is invalid, we reject the entire batch"* — so validate client-side and consider batches of 100–200 to limit blast radius.
- `event_time` *"can be up to 7 days before you send an event to Meta"*; exceeding it **fails the entire request** — verbatim: *"If any `event_time` in `data` is greater than 7 days in the past, we return an error for the entire request"*.
- **MISSED BY THE ORIGINAL DRAFT (fact-check 2026-09-02) — the 7-day rule is not universal.** For offline and physical-store events the window is **62 days**: *"For offline and physical store events…you should upload transactions within 62 days"*. If you ever backfill offline/CRM conversions, a hard-coded 7-day guard will reject valid events.
- `test_event_code` must be removed from production payloads.

### 9.3 Parameters

**Server event parameters** (https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event):

*Required:* `event_name`, `event_time` (Unix seconds, GMT), `user_data`, `action_source`. `app_data`/`extinfo` required for app events. `event_source_url` required specifically for website events (alongside `client_user_agent` and `action_source`).

*Optional:* `custom_data`, `opt_out`, `event_id`, `referrer_url`, `original_event_data`, `customer_segmentation`, `data_processing_options` (currently only `"LDU"`), `data_processing_options_country` (1 = USA, 0 = geolocate), `data_processing_options_state` (1000 = California, 0).

`action_source` enum: `email, website, app, phone_call, chat, physical_store, system_generated, business_messaging, other`. Meta explicitly states: *"By using the Conversions API, you agree that the `action_source` parameter is accurate to the best of your knowledge."*

**Customer information parameters** (https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/customer-information-parameters):

SHA-256 hashed, after normalization:

| Key | Field | Normalization |
|---|---|---|
| `em` | email | *"Trim any leading and trailing spaces. Convert all characters to lowercase."* |
| `ph` | phone | strip symbols/letters/leading zeros; include country code, e.g. `16505551212` |
| `fn`,`ln` | first/last name | *"Lowercase only with no punctuation."* Roman a–z; UTF-8 for special chars |
| `db` | date of birth | `YYYYMMDD` (2/16/1997 → `19970216`) |
| `ge` | gender | *"Gender in the form of an initial in lowercase"* — `f` / `m` |
| `ct` | city | *"Lowercase only with no punctuation, no special characters, and no spaces"* |
| `st` | state | 2-char ANSI lowercase (`az`, `ca`) |
| `zp` | zip | lowercase, no spaces/dashes, first 5 digits for US |
| `country` | country | ISO 3166-1 alpha-2, lowercase |
| `external_id` | your user id | *"Hashing recommended"* (not required); must be consistent across channels |

**Not hashed:** `client_ip_address`, `client_user_agent`, `fbc`, `fbp`, `subscription_id`, `fb_login_id`, `lead_id`, `anon_id`, `madid`, `page_id`, `page_scoped_user_id`, `ctwa_clid`, `ig_account_id`, `ig_sid`.

Hashing gotchas that cost a day: hash **after** normalization, not before; hex-encode lowercase; do not hash an empty string (omit the key entirely); the values are **arrays** (`"em": ["<hash>"]`) even for a single value.

### 9.4 `fbp` and `fbc`

Source: https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc

- `fbc` format: `version.subdomainIndex.creationTime.fbclid` → `fb.1.1554763741205.IwAR2F4-dbP0l7Mn1IawQQGCINEz7PYXQvwjNwB_qa2ofrHyiLjcbCRxTDMgk`
- `fbp` format: `version.subdomainIndex.creationTime.randomnumber` → `fb.1.1596403881668.1116446470`
- `version` is always `fb`. `subdomainIndex`: `com`=0, `example.com`=1, `www.example.com`=2. `creationTime` is **UNIX milliseconds**, not seconds — mixing this up with `event_time` (seconds) is a classic bug.
- If `_fbc` cookie is missing, construct it from the `fbclid` URL parameter as `fb.1.<ms timestamp when you first saw it>.<fbclid>`.
- *"ClickID value is case sensitive - do not apply any modifications before using"*.
- Recommended cookie lifetime: **90 days**.

`fbc` is the highest-value match key you control — it is a deterministic click identifier. Capture `fbclid` server-side at first landing, persist it against the session/user, and attach it to the eventual Purchase event even if that happens days later on another device.

### 9.5 Deduplication

Source: https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events

**Method 1 — `event_id` + `event_name` (recommended).**
*"In corresponding events, a Meta Pixel's `eventID` must match the Conversion API's `event_id`"* and *"a Meta Pixel's `event` must match the Conversion API's `event_name`."*
Browser side: `fbq('track','Purchase',{value:12,currency:'USD'},{eventID:'EVENT_ID'})`.
Tie-break: *"If server and browser events do not differ meaningfully in their content, we generally prefer the event that is received first."*

**Method 2 — `fbp` and/or `external_id` + `event_name`.** Weaker:
- *"only works for deduplicating events sent first from the browser and then through the server"*;
- server events are not discarded if no browser event arrived within 48 hours, even if an identical browser event comes later;
- *"Does not deduplicate events when only using one event source, that is browser-only or server-only."*

**Window: 48 hours.** Events are deduplicated if received *"within 48 hours of when we receive the first event with a given `event_id`"*.

**Engineering rules:** generate `event_id` server-side as a deterministic function of the business transaction (e.g. `sha256(order_id + event_name)`), never a random UUID generated independently on browser and server. Ship the same id to both `fbq(...,{eventID})` and CAPI. Send both sources — do not "optimize" by sending only server events, because browser events carry `fbp`/`fbc` and better `client_user_agent`.

### 9.6 Event Match Quality — the Dataset Quality API

This is the programmatic hook an autonomous system needs; everything else about EMQ is a UI.

```
GET https://graph.facebook.com/v26.0/dataset_quality
    ?dataset_id=<DATASET_ID>
    &fields=web{event_match_quality,event_name}
    &access_token=<TOKEN>
```
Source: https://developers.facebook.com/documentation/ads-commerce/conversions-api/dataset-quality-api

Response:
```json
{
  "web": [
    {
      "event_match_quality": {
        "composite_score": 6.2,
        "match_key_feedback": [
          {"identifier": "user_agent",  "coverage": {"percentage": 100}},
          {"identifier": "external_id", "coverage": {"percentage": 100}}
        ]
      },
      "event_name": "pLTVPurchase"
    }
  ]
}
```

- `composite_score` is **0–10**: *"how effective the customer information sent from your server may be at matching event instances to a Meta account."* Calculated in real time.
- Also returns deduplication metrics (% of browser and server events carrying a dedupe key), **event coverage** (*"7-day average percent of Pixel events that are covered by the Conversions API"*), **data freshness** (real-time/hourly/...), and **Additional Conversions Reported (ACR)**.
- Optional `agent_name` filters to a `partner_agent` value (normalized lowercase).
- Permissions: user "Partial access → Use events dataset"; app permissions `ads_read` + (`ads_management` or `business_management`). Advanced/high-volume use requires Full-Access `ads_management` plus the Marketing API Access Tier feature and app review.
- **Gotcha, quoted:** *"the client system user access token onboarding method is not compatible with the EMQ API at the moment."* If you onboarded via the client-system-user flow, this endpoint will not work for you.

**Use it as a control-loop input:** alert when `composite_score` drops, when a match key's `coverage.percentage` falls (someone changed the checkout and dropped `em`), or when dedupe coverage falls (a deploy broke `event_id` propagation). A silent EMQ regression looks exactly like "creative got worse" to a naive optimizer.

### 9.7 Setup / access

Source: https://developers.facebook.com/documentation/ads-commerce/conversions-api/get-started
- Token via **Events Manager → your Pixel → Settings → Conversions API → "Generate access token"**. *"The Generate access token link is only visible to users with developer privileges for the business."*
- Or via Business Settings: assign the Pixel to a **system user**, then generate a system-user token. This is the correct path for a platform.
- No app review or permission request is required for basic CAPI event sending.
- Since v12.0, tokens are not version-locked: they *"can be used with all available Graph API versions"*.
- The **Conversions API Gateway** is a Meta-hosted alternative (https://developers.facebook.com/documentation/ads-commerce/gateway-products/conversions-api-gateway) — relevant if you do not want to run the server-side pipeline yourself, but it removes your control over `event_id` generation and is therefore a poor fit for a system that wants clean dedup.

---

## 10. Conversion Lift / incrementality via API

**Status: gated.** The docs state plainly: *"Conversion Lift Measurement is currently limited. Please contact your Meta Representative for information about obtaining access."*
Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lift-studies

If you do have access:

```
POST https://graph.facebook.com/v26.0/{BUSINESS_ID}/ad_studies
```
Required fields: `name`, `type` (`"LIFT"`), `start_time` (must be in the future), `end_time`, `cells`, `objectives`.

`cells[]`: `treatment_percentage`, `control_percentage` (must sum to 100), `name`, `description`, and the ad entities (`adaccounts` or `campaigns`).

`objectives[]`:
```json
{"name": "new objective", "is_primary": true, "type": "CONVERSIONS", "applications": [{"id": "<APP_ID>"}]}
```
`type` currently supports `"CONVERSIONS"` only. Measurement sources: `adspixels`, `applications`, `offline_conversion_data_sets`, `customconversions`. At most one primary objective.

Read results:
```
GET /v26.0/{STUDY_OBJECTIVE_ID}?fields=results&breakdowns=[...]
```
Result breakdowns: `age`, `cell_id`, `gender`, `country` (country only in combination with `cell_id`).

Immutability: `start_time` and `treatment_percentage` cannot change after activation; associated ad objects cannot be removed; *"A lift study requires at least one objective. You cannot modify objectives after the study starts running."* Studies created after 2021-07-13 have no "buyers" metrics and no demographic breakdowns.

**Related but different:** the `incrementality`, `incrementality_all_conversions` and `incrementality_first_conversion` keys now present in `AdsActionStats` and in the `action_attribution_windows` enum (v26.0 SDK). **UNVERIFIED:** no public documentation explains what populates them or which accounts see them. Probe them; if populated they are a far cheaper incrementality read than a full lift study.

**Design consequence:** an autonomous platform serving self-serve advertisers **must assume Conversion Lift is unavailable**. Build your own incrementality instead:
- Geo holdouts implemented as targeting exclusions plus `breakdowns=country`/`region`.
- Budget-step experiments with a proper before/after design and a stabilization window (§5.2).
- Time-based holdouts using ad-set scheduling.
None of these are as clean as a Meta-run RCT, but they are the only options that do not require a sales representative.

---

## 11. Rate limits specific to insights

Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting

### 11.1 The formulas

Per ad account, per hour:

```
ads_management  = (100000 if Full access else 300 if Dev tier) + 40  * ActiveAds
ads_insights    = (190000 if Full access else 600 if Dev tier) + 400 * ActiveAds - 0.001 * UserErrors
```

Read the `ads_insights` formula carefully: **your own 4xx errors reduce your quota.** A retry storm against a malformed query is doubly punished. Validate parameters before sending and never blind-retry a `100`.

Also relevant: the Marketing API has a **100 requests-per-second** ceiling per app+ad-account for create/edit operations on campaigns, ad sets and ads. **Upgraded to verified-official (fact-check 2026-09-02)** — verbatim on the rate-limiting page: *"Limit: 100 requests per second (QPS) per app and ad account combination. Applied to: Create and edit operations for campaigns, ad sets, and ads."*

### 11.2 Access tiers — renamed 2026-05-04

- **Limited Access** (formerly "Standard Access") = the Marketing API **development** tier. Max score 60, decay 300 s.
- **Full Access** (formerly "Advanced Access") = the Marketing API **standard** tier. Max score 9000, decay 300 s.
- You are in the *development* tier if you have Limited Access to the "Ads Management Standard Access" feature; you are in the *standard* tier if you have Full Access to it.
- Applying for Full Access requires call volume: the requirement was reduced **from 1,500 to 500** Marketing API calls in the past 15 days (https://developers.facebook.com/docs/marketing-api/insights/best-practices/).
- **Rename date corrected (fact-check 2026-09-02):** the Marketing API changelog dates this entry **05/04/2026 (May 4, 2026)**, not May 5. The *feature* was also renamed, from "Ads Management Standard Access" to **"Marketing API Access Tier"**. Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog

**This is a hard gate on the whole product.** At 600 + 400·ActiveAds insights calls/hour, a dev-tier app with 10 active ads has ~4 600 calls/hour per account — workable for one account, not for a fleet. Plan for Full Access from day one, and note that reaching it requires shipping real traffic first.

### 11.3 Headers to read on every response

| Header | Contents |
|---|---|
| `X-FB-Ads-Insights-Throttle` | `{"app_id_util_pct": 100, "acc_id_util_pct": 10, "ads_api_access_tier": "standard_access"}` |
| `X-Business-Use-Case-Usage` | `call_count`, `total_cputime`, `total_time`, `estimated_time_to_regain_access` |
| `X-Ad-Account-Usage` | `acc_id_util_pct`, `reset_time_duration`, `ads_api_access_tier` |
| `X-App-Usage` | app-level percentages |

`ads_api_access_tier` values observed in docs: `standard_access`, `development_access` (the tier *labels* were renamed in the UI but the header values in the docs still use the old strings — **UNVERIFIED** whether the header string changed too; parse defensively).

**Back-off policy:** treat `app_id_util_pct` or `acc_id_util_pct` ≥ 90 as a stop signal and sleep to the next window. Meta's own guidance is *"Monitor header values; implement back-off at ~100% utility"* — waiting until 100 % is too late because throttling is already in effect.

### 11.4 Error codes

| Code | Subcode | Meaning |
|---|---|---|
| 4 | — | App-level rate limit exceeded (`CodedException`) |
| 4 | 1504022 | *"Too many API requests"* — insights-specific throttle |
| 17 | — | Account-level API limit. Throttle duration: **300 s (Dev tier), 60 s (Full access)** |
| 100 | 1487534 | Data-per-call limit exceeded: *"We use data-per-call limits to prevent a query from retrieving too much data beyond what the system can handle."* Applies to **sync and async alike**. |
| 100 | — | Invalid parameter |
| 190 | — | Invalid OAuth access token |
| 200 | — | Permissions error |
| 613 | — | Rate/burst limit |
| 2500 | — | Graph query parsing error |
| 2635 | — | Deprecated API version |
| 2642 | — | Invalid cursor values |
| 3018 | — | Start date exceeds the 37-month lookback window |

**Error 100 / 1487534 has no documented row threshold.** The fix is always the same: narrow the time range, drop a breakdown, or reduce the object count — *not* to lower `limit` (which only changes page size, not the amount of data the query materializes).

### 11.5 Quota-efficient sync design

Meta's own best-practice list, condensed:
- Prefer `date_preset` over custom ranges (cheaper to serve).
- Batch multiple sync requests (Graph batch API, up to 50 sub-requests).
- Avoid account-level queries with high-cardinality breakdowns — `action_target_id` and `product_id` are called out by name.
- Query unique metrics separately from totals.
- Pace queries **by ad account timezone** so you are not hammering every account at the same wall-clock instant.
- Space queries; back off at high utilization.

Concrete plan that works: one `level=ad`, `time_increment=1`, rolling-28-day, no-breakdown call per account per hour (this is the reward signal); one `publisher_platform,platform_position` breakdown call per account per day; one `age,gender` and one `country` call per account per day; async jobs for anything historical or backfill-shaped.

---

## 12. Gotchas

A list of things that each cost a day if you find them the hard way.

1. **`POST /insights` is the async trigger — there is no `async=true` parameter.** Sending `async=true` on a GET does nothing.
2. **`async_percent_completion == 100` does not mean done.** Poll `async_status == "Job Completed"` as well; reading results early yields silent partial data. Status strings are `"Job Completed"` etc. — spaces and title case.
3. **Never sum `actions[].value`.** `purchase`, `omni_purchase` and `offsite_conversion.fb_pixel_purchase` overlap. Pick one action_type per KPI.
4. **Never sum `reach` across days, ad sets, or breakdown rows.** It is de-duplicated per query. (**Sourcing, fact-check 2026-09-02:** this follows necessarily from the field definition — *"The number of Accounts Center accounts that saw your ads at least once… This metric is estimated"* — but Meta publishes no verbatim "do not sum reach" sentence. The *hourly*-breakdown half **is** verbatim: *"Hourly breakdowns do not support unique fields, which are any fields prepended with `unique_*`, `reach` or `frequency`. `reach` and `frequency` fields will return 0 when hourly breakdowns are in use."*) Sum of 7 daily reaches ≫ 7-day reach. Same for every `unique_*` field, `frequency` and `cpp`. If you need weekly reach, issue a separate weekly query.
5. **`frequency` is window-scoped.** It equals impressions ÷ reach *for the queried window only*, so daily frequency values cannot be averaged into a weekly frequency.
6. **Currency units are inconsistent across nodes — this is the highest-value gotcha in the whole API.** Budgets and caps are in the currency's **minimum denomination**: `spend_cap` docs say *"Value specified in basic unit of the currency, for example 'cents' for `USD`"*, and `daily_budget=100000` means $1,000.00. Insights `spend`, by contrast, is a **decimal string in major units**. Confirmed from Meta's own documented example response on https://developers.facebook.com/docs/marketing-api/insights/ : `{"impressions": "361324", "spend": "5339.5"}` — i.e. $5,339.50 at a ~$14.78 CPM. If `spend` were minor units that CPM would be $0.15. **So: write budgets in cents, read spend in dollars.** Parse `spend` with a Decimal, multiply by the currency offset to store an integer `spend_minor`, and never round-trip through a float.
7. **Zero-decimal currencies exist.** Currencies with offset 1 — there are **eleven**, not ten: `CLP, COP, CRC, HUF, IDR, ISK, JPY, KRW, PYG, TWD, VND`. **(`CRC` / Costa Rican Colón was missing from the original draft of this list — corrected by fact-check 2026-09-02.)** They have no minor unit — a bid of "1" is ¥1, not ¥0.01, and ₡1, not ₡0.01. Everything else uses offset 100. Verbatim: *"If a currency has an offset of 1 then the minimum bid equals one base currency unit."* Source: https://developers.facebook.com/docs/marketing-api/currencies/. A `/100` hard-coded anywhere in your budget code is a bug for those eleven currencies. Better: read `currency` off the ad account and look the offset up, never hard-code either constant.
8. **All dates are in the ad account's timezone.** Read `timezone_id`, `timezone_name`, `timezone_offset_hours_utc` off the ad account and convert; never assume UTC. `date_start`/`date_stop` are naive date strings with no zone suffix. A UTC-based scheduler will systematically fetch a shifted "yesterday".
9. **Timezone offset is not static.** `timezone_offset_hours_utc` reflects the current offset including DST. Store `timezone_name` (IANA) and resolve per-date, not the numeric offset.
10. **`hourly_stats_aggregated_by_advertiser_time_zone` vs `_by_audience_time_zone`** buckets differently; only the advertiser variant lines up with `date_start`. The audience variant is opt-in-gated from 2026-08-06.
11. **`7d_view` / `28d_view` still parse but return nothing** since 2026-01-12. No error is raised.
12. **`use_unified_attribution_setting` and `action_report_time` are silently ignored** since 2025-06-10. Code that sets them is dead code.
13. **Spend is impression-dated but web conversions are conversion-dated** in the same row (the `mixed` behaviour). Daily ROAS is a hybrid, not a cohort metric.
14. **`attribution_setting` varies per ad set.** Aggregating rows with different settings produces a meaningless number.
15. **`date_preset=lifetime` no longer exists.** Use `maximum` or `data_maximum`.
16. **`breakdowns=dma` is dead** since 2026-06-22 → `comscore_market`.
17. **`impression_device`, `hourly_stats_aggregated_by_audience_time_zone`, `frequency_value` require manual Ads Manager opt-in** for non-sales-supported accounts since 2026-08-06; sync requests return *no results*, not an error.
18. **Off-Meta conversions vanish under `region`/`dma`/hourly breakdowns.** You will conclude "this region has no purchases" when the API simply refuses to report them there.
19. **`ctr` uses all clicks; `inline_link_click_ctr` uses link clicks.** Comparing your CTR to any external benchmark without knowing which one is being quoted is meaningless.
20. **CAPI: one invalid event rejects the whole batch.** And `event_time` older than 7 days fails the whole request.
21. **CAPI: `fbc`/`fbp` `creationTime` is milliseconds; `event_time` is seconds.**
22. **CAPI: hash after normalization, and pass values as arrays.** `"em": ["<sha256 hex>"]`.
23. **CAPI dedup window is 48 hours** and the `fbp`/`external_id` method only works browser-first.
24. **The EMQ / Dataset Quality API does not work with client-system-user tokens**, per Meta's own note.
25. **Your own 4xx errors reduce your insights quota** (`- 0.001 * UserErrors`).
26. **Ranking diagnostics need ≥500 impressions** and have no documented enum — always have a default branch.
27. **`effective_status != configured_status`.** A `DISAPPROVED` ad looks like a zero-conversion ad to a naive optimizer, which will then "learn" the creative is bad.
28. **`recommendations` is absent, not empty, when there are none.**
29. **Marketing API versions expire in ~12 months, not 24.** And expired calls may auto-upgrade rather than fail.
30. **CAPI offline/physical-store events get 62 days, not 7.** A universal 7-day guard silently rejects valid offline backfills.
31. **Async jobs on the three opt-in-gated breakdowns are throttled to `min(10, number_of_ad_groups)` per 24 hours** — on a small account that is fewer than 10.
32. **Eleven currencies have offset 1, not ten** — `CRC` is the one everybody forgets.
33. **The public breakdowns reference is stale**: it still documents `dma` and never mentions `comscore_market`. OCC 2026 is authoritative; the breakdowns page is not.
34. **Marketing API v24.0 expires 2026-10-06.** Check your pin now.
35. **Requesting many fields with a wide date range and a breakdown hits error 100/1487534** with no row count to guide you. Narrow the range first; page size (`limit`) does not help.

---

## 13. Implications for this build

1. **One creative = one ad.** Do not use flexible/dynamic-creative multi-asset ads for the generated-video pipeline. Asset breakdowns cannot return ROAS or retention curves, and Meta's own asset selection confounds the comparison. Ad-level granularity is the only clean creative read.
2. **The warehouse must upsert a rolling 28-day window.** Key on `(date_start, level, object_id, breakdown_hash)`. Freeze >28 days. This is non-negotiable given the 28-day mutability guarantee.
3. **Stamp every row with `attribution_setting` and an internal `attribution_regime` version.** The 2026-01-12 (view windows) and March-2026 (engage-through) discontinuities will otherwise poison any model trained across them.
4. **Decision gate = `max(3 days, click_window_days)` since `last_sig_edit_ts`, plus ≥1 000 impressions, plus ≥ `dynamic_lp_conversions_threshold` (fallback 50) events.** Below that, only guardrail actions.
5. **Read `learning_stage_info.status` on every ad-set sync.** `FAIL` means Learning Limited — the correct response is consolidation (fewer ad sets, more budget each) or moving to an upper-funnel optimization event, never more creative iteration.
6. **Rate-limit budget is the architectural constraint, not API richness.** Design around one account-level `level=ad, time_increment=1` call per hour plus a small set of daily breakdown calls. Apply for Full Access early (needs ≥500 calls in 15 days).
7. **CAPI is a first-class subsystem, not an add-on.** Deterministic `event_id` derived from the order id, dual browser+server dispatch, `fbclid` captured at landing and persisted for ≥90 days, and a nightly `dataset_quality` poll that alarms on EMQ or dedupe-coverage regression.
8. **Two onboarding steps cannot be automated** and must be a human checklist: (a) domain verification + AEM 8-event configuration in Events Manager; (b) Ads Manager opt-in for `impression_device` / `frequency_value` / audience-timezone hourly breakdowns if you want them. Design the system to degrade gracefully without either.
9. **Incrementality must be home-grown.** Conversion Lift requires a Meta rep. Build geo/time holdouts on top of targeting and scheduling instead, and probe the undocumented `incrementality*` attribution keys opportunistically.
10. **Guardrails run on fresh data; optimization runs on settled data.** Two separate loops with two separate freshness contracts. Mixing them is how autonomous systems kill good ads on day-1 noise.

---

## 14. Open questions / UNVERIFIED

1. **Exact API string values for `quality_ranking` / `engagement_rate_ranking` / `conversion_rate_ranking`.** The tier structure (above/average/bottom-35/bottom-20/bottom-10) is documented in the Business Help Centre; the enum strings are not published anywhere and the SDK types them as bare `string`. Must be discovered empirically.
2. **Whether `quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking`, `unique_clicks`, `unique_ctr`, `video_thruplay_watched_actions` and `estimated_ad_recallers` are still in the v26.0 docs field table.** Two independent extractions of https://developers.facebook.com/documentation/ads-commerce/graph-api/reference/adgroup/insights failed to find them, but the official v26.0 Python SDK still declares all of them in `AdsInsights.Field` and `_field_types`, and Meta's own 2026-01 announcement discusses `unique_actions` as live. Most likely the doc page is too long for reliable extraction. **Confirm against a live account before removing them from your schema.**
3. **Whether `use_account_attribution_setting` still has any effect** now that ad-set attribution settings are applied by default (2025-06-10 change).
4. ~~Insights `spend` units.~~ **RESOLVED** while compiling this document: Meta's own example response on the Insights API page returns `"spend": "5339.5"` against `"impressions": "361324"`, which only makes sense as major units. Field description still does not state it, so re-verify if Meta changes the example.
5. **Maximum concurrent async report jobs** per app / per ad account — undocumented.
6. **Row/data ceiling behind error 100 subcode 1487534** — undocumented; there is no published row count.
7. **`dynamic_lp_status` enum values** and the exact semantics of dynamic learning-phase thresholds — undocumented.
8. **`issues_info.error_code` / `error_type` taxonomy** — only two example codes are published (2460003, 2460004).
9. **The `incrementality`, `incrementality_all_conversions`, `incrementality_first_conversion` attribution keys** — present in v26.0 schema, no documentation of eligibility or semantics.
10. **New creative/fatigue fields** (`creative_fatigue_summary`, `creative_fatigued_ads`, `creative_diversity_score`, `creative_diversity_label`, `opportunity_score_l4`, `thumb_stops`, `dwell_rate`, `attention_events_per_impression`) — present in the v26.0 field table, no per-field docs, sub-object shapes unknown.
11. **New AI-creative breakdowns** (`flexible_format_asset_type`, `gen_ai_asset_type`, `creative_automation_asset_id`, `creative_relaxation_asset_type`, `media_asset_url`, `media_type`, `breakdown_reporting_ad_id`) — present in the enum, no published legal-combination rules or value domains.
12. **Whether `ads_api_access_tier` header values changed** when the tier labels were renamed on 2026-05-05 from Standard/Advanced Access to Limited/Full Access. Docs still show `standard_access` / `development_access`.
13. **Marketing API v26.0 changelog page** currently renders v25.0 as the newest entry, contradicting the v26.0 launch blog post (2026-07-29) and the v26.0 SDK. The docs site appears stale in places; trust the SDK's `apiconfig.py` and the versions page.
14. **The official default attribution setting** for conversion campaigns (reported by multiple secondary sources as 7-day click / 1-day engage-through / 1-day view). Meta's help-centre pages are JS-rendered and could not be fetched; confirm by reading `attribution_setting` and `attribution_spec` off a live ad set.
15. **Significant-edit budget threshold.** The ±20 % rule is universal folklore; Meta publishes no number.

---

## 15. Source index

Official (developers.facebook.com):
- Graph API versions: https://developers.facebook.com/docs/graph-api/changelog/versions/
- v26.0 changelog: https://developers.facebook.com/docs/graph-api/changelog/version26.0/
- v26.0 launch blog: https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/
- Marketing API versions policy: https://developers.facebook.com/docs/marketing-api/versions/
- Marketing API changelog: https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog
- Ads Insights overview: https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights
- AdsInsights node reference (params + fields + error codes): https://developers.facebook.com/documentation/ads-commerce/graph-api/reference/adgroup/insights
- Breakdowns: https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/breakdowns and https://developers.facebook.com/docs/marketing-api/insights/breakdowns/
- Limits & best practices (async, throttle header, freshness): https://developers.facebook.com/docs/marketing-api/insights/best-practices/
- Rate limiting: https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting
- AdsActionStats: https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/
- Ad Set node (attribution_spec, statuses, issues_info, learning_stage_info): https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-campaign
- AdCampaignLearningStageInfo: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-learning-stage-info/
- AdCampaignIssuesInfo: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-issues-info/
- Ad Account node: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account
- Currencies & offsets: https://developers.facebook.com/docs/marketing-api/currencies/
- Asset-feed-spec insights (asset breakdowns): https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/insights/
- Lift studies: https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lift-studies
- Metric availability update (2026-01-12 attribution + retention): https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/
- Unique metric deprecation (2024-10-30): https://developers.facebook.com/blog/post/2024/08/07/ads-insights-api-unique-metric-updates/
- Out-of-cycle changes 2025: https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2025/
- Out-of-cycle changes 2026: https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026
- Conversions API overview: https://developers.facebook.com/documentation/ads-commerce/conversions-api
- CAPI using the API (endpoint, payload, 1000-event limit, 7-day window): https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api/
- CAPI server event parameters: https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event
- CAPI customer information parameters (hashing): https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/customer-information-parameters
- CAPI fbp/fbc: https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc
- CAPI deduplication: https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events
- CAPI best practices: https://developers.facebook.com/documentation/ads-commerce/conversions-api/best-practices
- CAPI get started (tokens): https://developers.facebook.com/documentation/ads-commerce/conversions-api/get-started
- Dataset Quality (EMQ) API: https://developers.facebook.com/documentation/ads-commerce/conversions-api/dataset-quality-api
- Aggregated Event Measurement (app): https://developers.facebook.com/documentation/app-events/guides/aggregated-event-measurement
- Manage ad object status: https://developers.facebook.com/documentation/ads-commerce/marketing-api/best-practices/manage-your-ad-object-status

Official (facebook.com — Business Help / Newsroom; JS-rendered, read via search snippets):
- Click attribution / engage-through announcement: https://www.facebook.com/business/news/click-attribution
- Engaged-view launch: https://www.facebook.com/business/news/engaged-view
- Set up engage-through: https://www.facebook.com/business/help/1055388958765938
- Attribution models & settings: https://www.facebook.com/business/help/460276478298895
- Ad relevance diagnostics: https://www.facebook.com/business/help/403110480493160
- Quality ranking: https://www.facebook.com/business/help/303639570334185
- Conversion rate ranking: https://www.facebook.com/business/help/617529305373441
- Learning phase: https://www.facebook.com/business/help/112167992830700/
- Learning Limited: https://www.facebook.com/business/help/269269737396981
- Significant edits: https://www.facebook.com/business/help/316478108955072
- AEM key concepts: https://www.facebook.com/business/help/387440828988900 and /721422165168355

Machine-readable (authoritative for field/enum lists):
- Python SDK AdsInsights: https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/adsinsights.py
- Python SDK AdAccount.get_insights: https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/adaccount.py
- Python SDK Ad (effective_status): https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/ad.py
- SDK version pin: https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/apiconfig.py

Secondary (used only where official docs were unreachable; flagged inline):
- https://ppc.land/meta-restricts-attribution-windows-and-data-retention-in-ads-insights-api/
- https://ppc.land/meta-unveils-creative-breakdown-for-flexible-formats-and-ai-generated-image-ads/
- https://seresa.io/blog/attribution-measurement/meta-killed-its-28-day-view-attribution-window-on-january-12-2026
- https://www.dataslayer.ai/blog/meta-attribution-change-2026-what-engage-through-attribution-is-and-why-your-numbers-look-different
- https://jetfuel.agency/meta-ads-attribution-settings-2026/
- https://docs.databricks.com/aws/en/ingestion/lakeflow-connect/meta-ads-limits
- https://github.com/airbytehq/airbyte/issues/14391


---

## Fact-check log

**Adversarial review date:** 2026-09-02. **Method:** every claim re-fetched against primary sources on `developers.facebook.com` (docs, changelogs, OCC pages, blog posts) plus the official Python SDK on `raw.githubusercontent.com`. Nothing below was accepted on the strength of a blog or an LLM prior. Where a claim was correct but the *citation* was wrong, the citation has been fixed in place.

### Verdicts

| # | Claim | Verdict | Notes |
|---|---|---|---|
| 1 | v26.0 current, released 2026-07-29; version table; Marketing API 90-day policy; auto-upgrade | **CONFIRMED** | Every date in the Graph version table verified individually (incl. v25.0 exp. 2028-07-29, v20.0 exp. 2026-09-24). SDK pins `API_VERSION 'v26.0'` / `SDK_VERSION 'v26.0.1'`. Marketing v23.0/v24.0 dates confirmed on the changelog. Marketing API v26.0 confirmed via the v26 launch blog — the Marketing changelog page is stale, not the claim. Auto-upgrade wording tightened (applies only to *unaffected* endpoints; can be disabled). |
| 2 | 7d_view / 28d_view return no data since 2026-01-12 | **CONFIRMED** | Verbatim on both OCC 2025 and the 2025-10-16 metric-availability blog. The 15–40% drop figure remains **verified-secondary** (unchanged). |
| 3 | `use_unified_attribution_setting` / `action_report_time` disregarded since 2025-06-10; ad-set attribution; inline folded; `mixed` dating | **CONFIRMED — citation corrected** | The two-parameter sentence is on OCC 2025. The *behavioural* detail is **not** on OCC 2025 (and OCC 2025's link to `insights#discrepancy-with-ads-manager` is a dead anchor). All three behavioural statements are verbatim on the **Insights best-practices** page, now cited there. |
| 4 | 15-minute refresh; rows immutable after 28 days; rolling-28-day refetch | **CONFIRMED** | Verbatim: *"Insights refresh every 15 minutes and do not change after 28 days of being reported."* The 5–15% under-report figure for a 7-day refetch is an estimate, not a Meta number. |
| 5 | Async triggered by POST; `async_status` title-case-with-spaces enum; poll both conditions; 30-day `report_run_id`; up-to-an-hour runtime | **CONFIRMED** | All six enum values confirmed verbatim. Meta's instruction confirmed verbatim: *"Poll this field until `async_status` is `Job Completed` and `async_percent_completion` is `100`."* |
| 6 | Async mandatory for four cases | **PARTIALLY REFUTED** | Cases (1) `mmm`, (2) 13-month `reach` (with the 10/account/day cap) and (4) sync timeouts (*"Try sync calls first and then use async calls in cases where sync calls timeout"*) all confirmed. **Case (3) is wrong:** async is not a workaround for the gated breakdowns — OCC 2026 grants async full history *"as long as you opted in"*, so opt-in gates both verbs. Also newly found: async on those breakdowns is throttled to **`min(10, number_of_ad_groups)` per 24 hours**. Corrected in §3.5(b) and §7.2. |
| 7 | Rate-limit formulas, tier rename, headers, error 17 durations | **CONFIRMED except the rename date** | Both formulas verbatim, including `- 0.001 * User Errors`. Max scores 60/9000 and 300s decay confirmed. Error 17: **300s block on dev tier, 60s on full access** — confirmed. 500-calls-in-15-days confirmed. **REFUTED detail:** the rename is dated **05/04/2026** on the Marketing API changelog, not 2026-05-05; the *feature* was also renamed to "Marketing API Access Tier". Bonus: the 100 QPS create/edit ceiling is **official**, not secondary — upgraded. |
| 8 | `learning_stage_info.status = FAIL`; no `LEARNING_LIMITED`; `dynamic_lp_*` fields | **CONFIRMED** | All seven fields and all three enum values verified verbatim against `AdCampaignLearningStageInfo`. No `LEARNING_LIMITED` value exists. `dynamic_lp_status` / `dynamic_lp_conversions_threshold` / `dynamic_lp_days_threshold` all present; `dynamic_lp_status`'s value domain remains undocumented. |
| 9 | ~50 optimization events / 7 days, only in JS-rendered help pages | **UNCERTAIN — and the researcher's own caveat is accurate** | Independently re-attempted `facebook.com/business/help/112167992830700`; the fetch returns the page **title only** ("About the Learning Phase"), no body. The rule cannot be confirmed against a fetchable primary source. The `verified-secondary` label was honest. Keep preferring `dynamic_lp_conversions_threshold` when populated. |
| 10 | `spend` in major units, budgets in minor units; zero-decimal currencies | **CONFIRMED on units, REFUTED on the currency list** | The documented example response `{"impressions": "361324", "spend": "5339.5"}` verified verbatim, so the major-units reading stands. `spend_cap`/`daily_budget` minor-units confirmed. **But the offset-1 list has ELEVEN members, not ten — `CRC` (Costa Rican Colón) was missing.** Full list: CLP, COP, **CRC**, HUF, IDR, ISK, JPY, KRW, PYG, TWD, VND. This is a real money bug. |
| 11 | `dma` removed 2026-06-22, replaced by `comscore_market` | **CONFIRMED** | Verbatim on OCC 2026. **Newly noted:** the public breakdowns reference is stale — it still documents `dma` and never mentions `comscore_market`, so `comscore_market`'s legal combinations are undocumented. |
| 12 | Three breakdowns opt-in from 2026-08-06 | **CONFIRMED** | All three breakdowns, the date, the "may return no results" wording and the Ads Manager opt-in path verified. Scope wording confirmed verbatim: *"This applies to non-sales-supported accounts only; sales-supported accounts are unaffected."* |
| 13 | Tiered retention 2026-01-12: 13mo unique+hourly, 6mo frequency_value, 37mo totals, mmm async-only; error 3018; 13-month reach rule | **CONFIRMED — one wording fix** | All four retention tiers and the mmm restriction confirmed on the 2025-10-16 blog. The 2025-06-10 reach rule confirmed verbatim on OCC 2025. **Error 3018's documented message is "Start date cannot exceed 37 months from current date"**, not "Start date exceeds 37-month lookback window" — paraphrase corrected. |
| 14 | Overlapping `actions[]` roll-ups; AdsActionStats value keys; `purchase_roas` is a ratio | **PARTIALLY REFUTED (sourcing)** | The **value keys are CONFIRMED verbatim** — `value`, `1d_click`, `1d_view`, `1d_ev`, `7d_click`, `28d_click`, `7d_view`, `28d_view`, `dda`, `inline`, `incrementality*`, `*_all_conversions`, `*_first_conversion`. **But the roll-up claim is not documented anywhere:** the reference never says `omni_*` aggregates other action types, and it does **not list a bare `purchase` action_type at all** — only `offsite_conversion.fb_pixel_purchase`, `app_custom_event.fb_mobile_purchase` and `omni_purchase`. Likewise `purchase_roas` is documented only as *"The total return on ad spend (ROAS) from purchases"* — the "ratio" reading and the `3.42` example are inference. Both downgraded to **verified-secondary**. The engineering advice (pick one action_type) is still right. Six previously-missed keys added to §2.3. |
| 15 | `reach`/`frequency`/`unique_*` de-duplicated, never summable; hourly returns 0 | **CONFIRMED (hourly) / CONFIRMED-BY-DEFINITION (summing)** | The hourly restriction is verbatim, including *"`reach` and `frequency` fields will return 0 when hourly breakdowns are in use."* The "never sum" rule follows necessarily from the `reach` definition (*"…saw your ads at least once… This metric is estimated"*) but Meta publishes no verbatim prohibition. Sourcing note added rather than the claim removed. |
| 16 | Asset breakdowns limited to 6 metrics + age/gender only | **CONFIRMED with a documented conflict** | The breakdowns page gives the six-field list; the asset-feed-spec page gives only *"actions, clicks, impressions"* (+ derived `ctr`, `actions_per_impressions`) — i.e. **no `spend`, `reach`, `action_values`**. Both agree on `age` / `gender` / `age, gender` as the only companions, and the example response shape is verbatim. Rely on the intersection. |
| 17 | Off-Meta conversions vanish under type-1 breakdowns; type-2 lose the breakdown value | **CONFIRMED** | Both group memberships and both statements verified verbatim on the breakdowns page. |
| 18 | CAPI endpoint, 1000 events/batch, all-or-nothing, 7-day `event_time`, `action_source` enum | **CONFIRMED — one important omission** | 1,000-event cap, all-or-nothing rejection and the 7-day rule all verbatim; all nine `action_source` values verified. **Omission:** offline and physical-store events get a **62-day** upload window, not 7. Also note the endpoint is documented as `{PIXEL_ID}` (dataset id is the same identifier) and `event_source_url` sits in the *optional* parameter table while being required for website events. |

### Corrections applied to this document

1. §12 gotcha 7 + §14 — **`CRC` added** to the offset-1 currency list (ten → eleven).
2. §11.2 — tier rename date **2026-05-05 → 2026-05-04**; feature rename to "Marketing API Access Tier" added.
3. §11.1 — 100 QPS ceiling upgraded from verified-secondary to verified-official with verbatim quote.
4. §7.2 + §3.5(b) — **async-mandatory case (3) struck and corrected**; `min(10, number_of_ad_groups)` per-24h async throttle added.
5. §4.3 — citation moved from OCC 2025 to the Insights best-practices page; three behavioural statements added verbatim; dead anchor flagged.
6. §2.3 — roll-up claim downgraded to verified-secondary with the reason; six missing AdsActionStats keys added.
7. §2.4 — `purchase_roas` "ratio" downgraded to verified-secondary.
8. §3.5(a) — breakdowns-reference staleness warning added; `comscore_market` combinations flagged undocumented.
9. §3.6 — asset-breakdown doc conflict documented; guidance to rely on the intersection.
10. §1.4 — error 3018 message wording corrected to Meta's actual string.
11. §4.5 — restored the third sentence of the `attribution_setting` description (campaign/account values are *derived*).
12. §9.2 — CAPI 62-day offline/physical-store window added; 7-day error wording quoted verbatim.
13. §12 gotchas 5 (reach) sourcing note; §0 Marketing API v26.0 resolution + tightened auto-upgrade wording; new gotchas 30–34.

### Still unverified after adversarial review

- **The ~50-events/7-day learning rule.** `facebook.com/business/help/*` is JS-rendered; a direct fetch returns the title only. Genuinely unconfirmable without a browser.
- **`dynamic_lp_status` value domain**, `issues_info.error_code` taxonomy, ranking-diagnostic enum strings, the `incrementality*` keys' eligibility, and the new creative/fatigue field shapes — all re-checked, all still undocumented. The researcher's UNVERIFIED marks were correct.
- **Whether `use_account_attribution_setting` still does anything.** The reference still says `use_unified_attribution_setting=true` causes it to be ignored — but that parameter is itself now disregarded, so the interaction is undefined in the docs. Must be tested live.
- **`ads_api_access_tier` header string values** after the May 2026 rename. Docs still show `standard_access`; parse defensively.
- **Max concurrent async jobs** and the row ceiling behind error 100/1487534 — still undocumented.
- **The 15–40% view-attribution conversion drop and the 5–15% cost of a 7-day refetch** — both are secondary/estimated figures, not Meta numbers. Fine as planning heuristics, not as contract.
