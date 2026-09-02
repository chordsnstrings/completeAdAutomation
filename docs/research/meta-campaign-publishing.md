# Meta Marketing API — Campaign / Ad Set / Ad Creation & Publishing

**Research date:** 2026-09-02
**Scope:** the exact API path from "we have a video file and a business brief" to "a live, delivering ad on Facebook/Instagram."
**Confidence convention used throughout:** claims sourced to `developers.facebook.com` are treated as authoritative. Anything from a blog/secondary source is labelled **[SECONDARY]**. Anything I could not confirm is labelled **UNVERIFIED**.

---

## 0. Version baseline (read this first — it invalidates most pre-2026 tutorials)

| Fact | Value | Source |
|---|---|---|
| Current Graph API / Marketing API version | **v26.0**, released **2026-07-29** | https://developers.facebook.com/docs/graph-api/changelog |
| Previous | v25.0 (2026-02-18, available until 2028-07-29) | same |
| Previous | v24.0 (2025-10-08, available until 2028-02-18) | same |
| Previous | v23.0 (2025-05-29, available until **2027-10-08** — ~~already expired 2026-06-09~~ **CORRECTED 2026-09-02: v23.0 is NOT expired**) | https://developers.facebook.com/docs/graph-api/changelog |
| Previous | v22.0 (2025-01-21, available until 2027-05-20) · v21.0 (2024-10-02, until 2027-01-21) · v20.0 (2024-05-21, until 2026-09-24) | same |
| Oldest still-usable at time of writing | **v20.0** — expires 2026-09-24, i.e. within a month of this document's date | same |
| Base URL | `https://graph.facebook.com/v26.0/...` | — |

**Pin an explicit version in every call.** ~~Unversioned calls resolve to the oldest *non-expired* version.~~ **CORRECTED 2026-09-02:** an unversioned call uses *"the version set in the app dashboard **Upgrade API Version** card under **Settings > Advanced**"* — i.e. a value another human can change in the App Dashboard without touching your code. Only *after a version expires* do *"any calls made to it ... [get] defaulted to the next oldest, usable version."* Either way the effective version can move under you, so pin it. (https://developers.facebook.com/docs/graph-api/guides/versioning) Error `2635` = "You are calling a deprecated version of the Ads API. Please update to the latest version." (https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads/)

Version-availability window, verbatim: *"A version will no longer be usable two years after the date that the subsequent version is released."* (Note: two years after the **next** version ships, not after its own release — that is why v23.0 lives until 2027-10-08, two years after v24.0's 2025-10-08.) For an autonomous platform you need a **version-pin config value plus a quarterly upgrade job**, because Meta's breaking changes (below) have repeatedly been applied *retroactively to all versions* 90 days after a release.

### The four changelog entries that matter most for a greenfield build

1. **v26.0 (2026-07-29)** — `targeting_automation.advantage_audience` must be **explicitly set** (to `1` or `0`) when *creating* an ad set with a constrained audience in the Housing / Employment / Financial Products special ad categories. Previously it was defaulted. Applies to creation only, not updates. (https://developers.facebook.com/docs/graph-api/changelog/version26.0)
2. **v26.0** — Instagram **Explore Feed** placement removed; ad sets specifying it error on create/update. Messenger **Stories** silently dropped from `messenger_positions`. Poll creatives (`poll_spec`, `interactive_components_spec: poll`) rejected. Delivery Estimate loses `daily_outcomes_curve`, `budget_guardrail`, `estimate_dau` with **no replacement**. (v26.0 changelog; corroborated https://ppc.land/meta-blocks-47-commerce-endpoints-as-graph-api-v26-0-lands-today/)
3. **v25.0 (2026-02-18)** — "creation, duplication, and updates to Advantage+ shopping campaigns and Advantage+ app campaigns is no longer allowed" on `POST /{ad-account-id}/campaigns` and `POST /{campaign-id}/copies`; extended to **all API versions on 2026-05-19**. (https://developers.facebook.com/docs/graph-api/changelog/version25.0)
4. **v24.0 (2025-10-08)** — `is_adset_budget_sharing_enabled` is **required on `POST /act_{id}/campaigns` if you intend to set budgets at the ad-set level**. Daily-budget flexibility widened from 25% → **75%** overspend on a given day (weekly still capped at 7× daily). New `placement_soft_opt_out` (up to 5% of spend can go to excluded placements). Facebook `video_feeds` placement delivery stopped. (https://developers.facebook.com/docs/graph-api/changelog/version24.0)

---

## 1. Object hierarchy and the four endpoints

```
Ad Account  act_{ad_account_id}
  └── Campaign            objective, special_ad_categories, buying_type, (optional) budget
        └── Ad Set        budget, schedule, targeting, optimization_goal, billing_event,
        │                 bid_strategy, promoted_object, destination_type, attribution_spec
        │     └── Ad      name + creative reference + status  (+ conversion_domain)
        └── (Ad Creative lives on the AD ACCOUNT, not inside the ad set —
             it is created separately and referenced by id from the Ad)
```

| Object | Create endpoint | Node reference |
|---|---|---|
| Campaign | `POST /v26.0/act_{ad_account_id}/campaigns` | https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group |
| Ad Set | `POST /v26.0/act_{ad_account_id}/adsets` | https://developers.facebook.com/docs/marketing-api/reference/ad-campaign |
| Ad Creative | `POST /v26.0/act_{ad_account_id}/adcreatives` | https://developers.facebook.com/docs/marketing-api/reference/ad-creative/ |
| Ad | `POST /v26.0/act_{ad_account_id}/ads` | https://developers.facebook.com/docs/marketing-api/reference/adgroup/ |
| Video upload | `POST /v26.0/act_{ad_account_id}/advideos` | https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/ |
| Image upload | `POST /v26.0/act_{ad_account_id}/adimages` | (returns `images.{filename}.hash` → `image_hash`) |

**Naming trap:** the API node names do not match the product names. `ad-campaign-group` = Campaign. `ad-campaign` = **Ad Set**. `adgroup` = **Ad**. Every SDK and doc URL uses the internal names, so `/docs/marketing-api/reference/ad-campaign` is the *ad set* page. This costs people an hour the first time.

### Account-level object limits
- Regular ad account: **6,000** non-archived ads, ad sets, and campaigns *each*; bulk accounts: 50,000 ads / 10,000 ad sets / 10,000 campaigns. (https://developers.facebook.com/docs/marketing-api/reference/ad-account/)
- Max **5,000** non-deleted ad sets per regular account, **10,000** for bulk; max **50 non-archived ads per ad set**. (https://developers.facebook.com/docs/marketing-api/adset/)
- Archived objects: limit **100,000** per ad account; archived objects allow editing only `name` and `status`, and can only transition to `DELETED`. (https://developers.facebook.com/documentation/ads-commerce/marketing-api/best-practices/manage-your-ad-object-status)

For an automation platform that generates many creative variants, the "50 ads per ad set" and "6,000 per account" ceilings are the ones you will actually hit. Plan an archive/delete GC job. Note: **a deleted ad may still accrue impressions/clicks/actions for 28 days after delivery** (same source) — do not treat DELETE as an immediate kill switch; use `status=PAUSED` for that.

---

## 2. Access, permissions and rate limits (the gate before any of this works)

- Permission required: **`ads_management`** (own ads) — Advanced Access to `ads_read` and/or `ads_management` if managing other people's ads. (https://developers.facebook.com/docs/marketing-api/overview/authorization)
- Two access tiers, verbatim: **Limited/Development** — *"Heavily rate-limited per ad account. For development only. Not for production apps running for live advertisers."* vs **Full/Standard** — *"Lightly rate limited per ad account"*, granted after App Review.
- Qualification for Full Access: *"Have successfully made at least 500 Marketing API calls in the last 15 days"* and *"Have made Marketing API calls with an error rate of less than 15% in the last 500 calls."*
- *"Calls on ANY access level are against production data"* — there is no sandbox that avoids real ad accounts. (Meta does offer sandbox ad accounts that never spend, but they behave differently; treat that as **UNVERIFIED** for 2026.)

**Rate limit formula (`ads_management` BUC, per ad account, per rolling hour), verbatim:**
> `(100000 if your app is in the Marketing API Full access or 300 if your app is in the Dev tier) + 40 * Num of Active ads`
(https://developers.facebook.com/docs/marketing-api/overview/rate-limiting)

That "+40 × active ads" term is the load-bearing part: a brand-new account in Dev tier gets **300 calls/hour total**, which a naive create-poll loop burns through in minutes. Design for exponential backoff from day one.

Throttle error codes (**expanded 2026-09-02 — the original list was incomplete**):
- `17` / subcode `2446079` — "User request limit reached"
- `613` / subcodes `1487742`, **`5044001`, `1487632`, `1487225`** — "There have been too many calls from this ad-account"
- `4` / subcodes **`1504022`, `1504039`** — application-level request limit
- `80000`, `80003`, **`80004`**, `80014` — Business Use Case rate limits (different BUCs; `80004` is the ads one)

Also on the rate-limit page: the two tiers carry a **60-point** (Development) vs **9000-point** (Standard/Full) maximum score in Meta's scoring model, separate from the call-count formula above.

Headers to read on every response: `X-Ad-Account-Usage` (`acc_id_util_pct`, `reset_time_duration`, `ads_api_access_tier`) and `X-Business-Use-Case-Usage` (`call_count`, `total_cputime`, `total_time`, `estimated_time_to_regain_access`) — the rate-limiting page renders this header name inconsistently (`X-Business-Use-Case` in places); read both spellings defensively. Back off on `acc_id_util_pct` > ~75 rather than waiting for the 613.

**Batching:** `POST /v26.0/` with a `batch` array, **max 50 requests per batch**, and dependent requests via `{result=REQUEST-NAME:$.data.*.id}` JSONPath referencing a prior operation's `name`. Critically: *"Each call within the batch is counted separately for the purposes of calculating API call limits"* — batching saves round trips and lets you chain campaign→adset→ad in one HTTP call, but **saves you nothing on rate limit**. (https://developers.facebook.com/docs/graph-api/batch-requests)

---

## 3. Campaign — `POST /act_{ad_account_id}/campaigns`

### Required
| Field | Type | Notes |
|---|---|---|
| `name` | string | supports emoji |
| `objective` | enum | see §4 |
| `special_ad_categories` | **array** | **mandatory even when empty-ish** — send `[]` or `["NONE"]`. Forgetting it is error 100. |

### Frequently-used optional
| Field | Type | Notes |
|---|---|---|
| `status` | `ACTIVE` \| `PAUSED` | only those two are valid *at creation* |
| `buying_type` | string | default `AUCTION`; `RESERVED` for reach & frequency |
| `bid_strategy` | enum | `LOWEST_COST_WITHOUT_CAP`, `LOWEST_COST_WITH_BID_CAP`, `COST_CAP`, `LOWEST_COST_WITH_MIN_ROAS`. Docs list default `LOWEST_COST_WITH_BID_CAP` — **set it explicitly**. Only meaningful when the budget is at campaign level. |
| `daily_budget` / `lifetime_budget` | int64 (minor units) | presence of either = Campaign Budget Optimization / Advantage campaign budget |
| `spend_cap` | int64 | lifetime spend ceiling; **minimum $100 USD** or local equivalent; set to `922337203685478` to remove |
| `is_adset_budget_sharing_enabled` | bool | **required since v24.0 if you plan to put budgets on ad sets instead** |
| `special_ad_category_country` | list<ISO-2> | see §5 |
| `campaign_optimization_type` | enum | `NONE` \| `ICO_ONLY` |
| `promoted_object` | object | used by some campaign types (e.g. app) |
| `adlabels` | list | free-form labelling — genuinely useful for an automation platform's own bookkeeping |
| `source_campaign_id` | numeric string | set automatically on copies |
| `is_skadnetwork_attribution` | bool | iOS 14+ app campaigns |
| `smart_promotion_type` | enum | **DEAD for creation** — see §7 |

Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group

### Example
```bash
curl -X POST "https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/campaigns" \
  -F "name=AUTO-2026-09-02-sales-us-v1" \
  -F "objective=OUTCOME_SALES" \
  -F "status=PAUSED" \
  -F "special_ad_categories=[]" \
  -F "buying_type=AUCTION" \
  -F "bid_strategy=LOWEST_COST_WITHOUT_CAP" \
  -F "daily_budget=5000" \
  -F "access_token=<TOKEN>"
# -> {"id":"120210000000000000"}
```
JSON-body equivalent (note `special_ad_categories` must be a JSON array, not a bare string):
```json
{
  "name": "AUTO-2026-09-02-sales-us-v1",
  "objective": "OUTCOME_SALES",
  "status": "PAUSED",
  "special_ad_categories": [],
  "buying_type": "AUCTION",
  "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
  "daily_budget": 5000
}
```

Campaign `effective_status` enum is short: `ACTIVE, PAUSED, DELETED, ARCHIVED, IN_PROCESS, WITH_ISSUES`. **No review states exist at campaign level** — review lives on the Ad (§11).

Documented error codes on the campaign node: `100` (invalid parameter), `613` (rate limit), `190` (bad token), `200` (permissions), `80004` (too many ad-account calls), `2500` (Graph query parse), `2635` (deprecated version), `3018` (**start date beyond 37 months**), `104` (incorrect signature), `801` (invalid operation).

---

## 4. ODAX objectives and the legality matrix

### 4.1 The six current objectives
`OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_APP_PROMOTION`, `OUTCOME_SALES` — described in the docs as *"designed to eventually replace the original objectives."*

The legacy values (`APP_INSTALLS, BRAND_AWARENESS, CONVERSIONS, EVENT_RESPONSES, LEAD_GENERATION, LINK_CLICKS, LOCAL_AWARENESS, MESSAGES, OFFER_CLAIMS, PAGE_LIKES, POST_ENGAGEMENT, PRODUCT_CATALOG_SALES, REACH, STORE_VISITS, VIDEO_VIEWS`) are still *listed* in the enum on the reference page. **UNVERIFIED** whether creation with a legacy objective still succeeds in v26.0 — Ads Manager has been ODAX-only since 2023 and multiple secondary sources say legacy objectives are no longer creatable. **Design decision: only ever emit `OUTCOME_*`.** The docs do warn: *"Trying to duplicate existing objective campaigns to use the new objective values may throw an error."*

### 4.2 destination_type legality per objective (VERBATIM from the docs)

Source: https://developers.facebook.com/docs/marketing-api/adset/destination_type/

| Objective | Available `destination_type` |
|---|---|
| `OUTCOME_AWARENESS` | `UNDEFINED`, `WEBSITE`, `MESSENGER`, `WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`, `MESSAGING_MESSENGER_WHATSAPP`, `INSTAGRAM_DIRECT` |
| `OUTCOME_TRAFFIC` | `UNDEFINED`, `MESSENGER`, `WHATSAPP`, `PHONE_CALL` |
| `OUTCOME_ENGAGEMENT` | `UNDEFINED`, `MESSENGER`, `WHATSAPP`, `PHONE_CALL`, `INSTAGRAM_DIRECT`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`, `MESSAGING_MESSENGER_WHATSAPP`, `ON_POST`, `ON_EVENT`, `ON_VIDEO`, `ON_PAGE` |
| `OUTCOME_APP_PROMOTION` | `UNDEFINED` |
| `OUTCOME_LEADS` | `ON_AD`, `LEAD_FROM_MESSENGER`, `LEAD_FROM_IG_DIRECT`, `PHONE_CALL`, `UNDEFINED`, `WEBSITE`, `APP` |
| `OUTCOME_SALES` | `WEBSITE`, `MESSENGER`, `PHONE_CALL` |

Per-value requirements (verbatim highlights):
- `APP` — *"Ads in the ad set must provide an app ID in the promoted object"*
- `WEBSITE` — *"All ads in the ad set must have ad creative with at least one valid, external URL"*
- `MESSENGER` / `WHATSAPP` — creative must have that surface as its destination
- `ON_AD` — parent campaign objective must be in `{OUTCOME_LEADS}` (instant forms)
- `ON_POST` / `ON_VIDEO` / `ON_PAGE` / `ON_EVENT` — parent objective must be `OUTCOME_ENGAGEMENT`
- `UNDEFINED` — *"Returned only in read mode if you have objectives that do not appear in the Objectives table"*
- `PHONE_CALL` — the per-value requirement table says *"Objective must be `PRODUCT_CATALOG_SALES` or `CONVERSIONS`"* (docs still use the **legacy** objective names here, which contradicts the objective table above listing `PHONE_CALL` under `OUTCOME_TRAFFIC`/`OUTCOME_ENGAGEMENT`/`OUTCOME_LEADS`/`OUTCOME_SALES`). **Added 2026-09-02** — treat `PHONE_CALL` as needing an empirical test.
- `APPLINKS_AUTOMATIC` — Advantage+ catalog ads; requires `product_set_id`. **Added 2026-09-02** (missing from the original write-up)
- `FACEBOOK` — Advantage+ catalog ads, *"currently only available for the Vehicle vertical"*. **Added 2026-09-02**

**Note the trap:** `OUTCOME_TRAFFIC` does **not** list `WEBSITE` in that table, and `OUTCOME_SALES` does not list `UNDEFINED`. For a plain website-traffic ad set under `OUTCOME_TRAFFIC`, the working pattern is to **omit `destination_type` entirely** (it resolves to the website default) rather than send `WEBSITE`. **UNVERIFIED** — worth an empirical test on a real account as one of the first integration tests.

### 4.3 ODAX mapping table — objective × optimization_goal × destination_type × promoted_object

Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group — section **"Outcome-Driven Ads Experiences Objective Validation" → "Objective Mapping"**.

~~The anchor is only reachable via the `/documentation/ads-commerce/...` mirror of the URL, not the `/docs/marketing-api/...` one.~~ **CORRECTED 2026-09-02:** this is false. The Objective Mapping table is present on the ordinary `/docs/marketing-api/reference/ad-campaign-group` page. The `/documentation/ads-commerce/...` URL is a mirror of the same content; either works. Do not build tooling around the mirror URL.

| Legacy objective | New objective | destination_type | optimization_goal | promoted_object |
|---|---|---|---|---|
| BRAND_AWARENESS | `OUTCOME_AWARENESS` | — | `AD_RECALL_LIFT` | `page_id` |
| REACH | `OUTCOME_AWARENESS` | — | `REACH` | `page_id` |
| REACH | `OUTCOME_AWARENESS` | — | `IMPRESSIONS` | `page_id` |
| VIDEO_VIEWS | `OUTCOME_AWARENESS` | — | `THRUPLAY` | `page_id` |
| VIDEO_VIEWS | `OUTCOME_AWARENESS` | — | `TWO_SECOND_CONTINUOUS_VIDEO_VIEWS` | `page_id` |
| LINK_CLICKS | `OUTCOME_TRAFFIC` | — | `LINK_CLICKS` | `application_id`, `object_store_url` |
| LINK_CLICKS | `OUTCOME_TRAFFIC` | — | `LANDING_PAGE_VIEWS` | — |
| LINK_CLICKS | `OUTCOME_TRAFFIC` | — | `REACH` | `application_id`, `object_store_url` |
| LINK_CLICKS | `OUTCOME_TRAFFIC` | — | `IMPRESSIONS` | — |
| LINK_CLICKS | `OUTCOME_TRAFFIC` | `MESSENGER` | `LINK_CLICKS` / `REACH` / `IMPRESSIONS` | — |
| LINK_CLICKS | `OUTCOME_TRAFFIC` | `WHATSAPP` | `LINK_CLICKS` / `REACH` / `IMPRESSIONS` | `page_id` |
| LINK_CLICKS | `OUTCOME_TRAFFIC` | `PHONE_CALL` | `QUALITY_CALL` / `LINK_CLICKS` | — |
| POST_ENGAGEMENT | `OUTCOME_ENGAGEMENT` | `ON_POST` | `POST_ENGAGEMENT` / `REACH` / `IMPRESSIONS` | — |
| PAGE_LIKES | `OUTCOME_ENGAGEMENT` | `ON_PAGE` | `PAGE_LIKES` | `page_id` |
| EVENT_RESPONSES | `OUTCOME_ENGAGEMENT` | `ON_EVENT` | `EVENT_RESPONSES` / `POST_ENGAGEMENT` / `REACH` / `IMPRESSIONS` | — |
| VIDEO_VIEWS | `OUTCOME_ENGAGEMENT` | `ON_VIDEO` | `THRUPLAY` / `TWO_SECOND_CONTINUOUS_VIDEO_VIEWS` | — |
| MESSAGES | `OUTCOME_ENGAGEMENT` | `MESSENGER` | `CONVERSATIONS` / `LINK_CLICKS` / `LEAD_GENERATION` | `page_id` |
| CONVERSIONS | `OUTCOME_ENGAGEMENT` | — | `OFFSITE_CONVERSIONS` | `pixel_id` + `custom_event_type` |
| CONVERSIONS | `OUTCOME_ENGAGEMENT` | — | `OFFSITE_CONVERSIONS` | `application_id` + `object_store_url` |
| CONVERSIONS | `OUTCOME_ENGAGEMENT` | — | `LINK_CLICKS` / `REACH` / `LANDING_PAGE_VIEWS` / `IMPRESSIONS` | `pixel_id` + `custom_event_type` |
| APP_INSTALL | `OUTCOME_APP_PROMOTION` | — | `LINK_CLICKS` / `OFFSITE_CONVERSIONS` / `APP_INSTALLS` | `application_id` + `object_store_url` |
| LEAD_GENERATION | `OUTCOME_LEADS` | `ON_AD` | `LEAD_GENERATION` / `QUALITY_LEAD` | `page_id` |
| LEAD_GENERATION | `OUTCOME_LEADS` | `LEAD_FROM_MESSENGER` | `LEAD_GENERATION` | `page_id` |
| LEAD_GENERATION | `OUTCOME_LEADS` | `LEAD_FROM_IG_DIRECT` | `LEAD_GENERATION` | `page_id` |
| LEAD_GENERATION | `OUTCOME_LEADS` | `PHONE_CALL` | `QUALITY_CALL` | `page_id` |
| CONVERSIONS | `OUTCOME_LEADS` | — | `OFFSITE_CONVERSIONS` | `pixel_id` + `custom_event_type` |
| CONVERSIONS | `OUTCOME_LEADS` | — | `OFFSITE_CONVERSIONS` | `application_id` + `object_store_url` |
| CONVERSIONS | `OUTCOME_LEADS` | — | `LINK_CLICKS` | `pixel_id` + `custom_event_type` |
| PRODUCT_CATALOG_SALES | `OUTCOME_SALES` | — | `OFFSITE_CONVERSIONS` / `LINK_CLICKS` / `REACH` / `IMPRESSIONS` | `product_set_id` + `custom_event_type` |

**Gap — and it is worse than first assessed. CORRECTED 2026-09-02:** the original note assumed the table merely *truncated* before a `CONVERSIONS → OUTCOME_SALES` block. Two independent re-retrievals (both the `/docs/` page and the `/documentation/ads-commerce/` mirror) enumerate the second column as exactly `OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_APP_PROMOTION, OUTCOME_LEADS` — **`OUTCOME_SALES` never appears as a target objective anywhere in the Objective Mapping table**, even though `PRODUCT_CATALOG_SALES` does appear in the legacy column. So:

- The row `PRODUCT_CATALOG_SALES → OUTCOME_SALES` in the table above is **NOT CONFIRMED** against the live doc. Do not treat it as quoted. (Retrieval truncation on the tail of the table means it cannot be positively refuted either — it is genuinely **UNVERIFIED**.)
- There is **no documented ODAX mapping row for the website-purchase case at all**. This is a documentation hole, not a retrieval artifact.

The expected legal shape below is therefore inference, and the *only* way to settle it is a live create call:

```
objective          = OUTCOME_SALES
destination_type   = WEBSITE       (or omitted)
optimization_goal  = OFFSITE_CONVERSIONS
billing_event      = IMPRESSIONS
promoted_object    = { pixel_id, custom_event_type: "PURCHASE" }
```
Marked **inferred, load-bearing** — verify against a live account before building on it. `VALUE` is also a legal `optimization_goal` for value-optimised sales (it appears in the ad set enum and is required for `LOWEST_COST_WITH_MIN_ROAS`), but I could not find it in the ODAX mapping table — **UNVERIFIED**.

### 4.4 optimization_goal → billing_event legality (VERBATIM)

Source: https://developers.facebook.com/docs/marketing-api/bidding/overview/billing-events/

| optimization_goal | Valid billing_event |
|---|---|
| APP_INSTALLS | IMPRESSIONS |
| AD_RECALL_LIFT | IMPRESSIONS |
| ENGAGED_USERS | IMPRESSIONS |
| EVENT_RESPONSES | IMPRESSIONS |
| IMPRESSIONS | IMPRESSIONS |
| LEAD_GENERATION | IMPRESSIONS |
| **LINK_CLICKS** | **LINK_CLICKS, IMPRESSIONS** |
| OFFSITE_CONVERSIONS | IMPRESSIONS |
| PAGE_LIKES | IMPRESSIONS |
| POST_ENGAGEMENT | IMPRESSIONS |
| REACH | IMPRESSIONS |
| REPLIES | IMPRESSIONS |
| SOCIAL_IMPRESSIONS | IMPRESSIONS |
| **THRUPLAY** | **IMPRESSIONS, THRUPLAY** |
| **TWO_SECOND_CONTINUOUS_VIDEO_VIEWS** | **IMPRESSIONS, TWO_SECOND_CONTINUOUS_VIDEO_VIEWS** |
| VALUE | IMPRESSIONS |
| LANDING_PAGE_VIEWS | IMPRESSIONS |

**Practical rule: `billing_event = "IMPRESSIONS"` is legal for every optimization goal.** Hard-code it unless you have a specific reason. Only three goals accept anything else.

And by `buying_type`:

| billing_event | AUCTION | RESERVED | FIXED_CPM |
|---|---|---|---|
| IMPRESSIONS | ✓ | ✓ | ✓ |
| LINK_CLICKS | ✓ | — | — |
| PAGE_LIKES | ✓ | — | — |
| POST_ENGAGEMENT | ✓ | — | — |
| VIDEO_VIEWS | ✓ | — | — |

Full `optimization_goal` enum on the ad set node: `APP_INSTALLS, AD_RECALL_LIFT, ENGAGED_USERS, EVENT_RESPONSES, IMPRESSIONS, LEAD_GENERATION, QUALITY_LEAD, LINK_CLICKS, OFFSITE_CONVERSIONS, PAGE_LIKES, POST_ENGAGEMENT, QUALITY_CALL, REACH, LANDING_PAGE_VIEWS, VISIT_INSTAGRAM_PROFILE, VALUE, THRUPLAY, DERIVED_EVENTS, CONVERSATIONS, IN_APP_VALUE, MESSAGING_PURCHASE_CONVERSION, SUBSCRIBERS, PROFILE_VISIT`.
Full `billing_event` enum: `APP_INSTALLS, CLICKS, IMPRESSIONS, LINK_CLICKS, NONE, OFFER_CLAIMS, PAGE_LIKES, POST_ENGAGEMENT, THRUPLAY, PURCHASE, LISTING_INTERACTION`.
(https://developers.facebook.com/docs/marketing-api/reference/ad-campaign)

**Engineering recommendation:** encode §4.2–§4.4 as a hard-coded validation table in your own code and reject illegal tuples *before* the API call. Meta's rejection for an illegal tuple is a generic `code 100 "Invalid parameter"` with an unhelpful `error_user_msg`, so client-side validation is the difference between a clear log line and a 3-hour debug session.

---

## 5. `special_ad_categories` — mandatory, and it silently rewrites your targeting

Enum: `NONE`, `EMPLOYMENT`, `HOUSING`, `CREDIT`, `ISSUES_ELECTIONS_POLITICS`, `ONLINE_GAMBLING_AND_GAMING`, `FINANCIAL_PRODUCTS_SERVICES`.
(https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group)

It is an **array** and it is **required on campaign creation**. Send `[]` (or `["NONE"]`) for ordinary commercial advertising.

Restrictions for HOUSING / EMPLOYMENT / FINANCIAL_PRODUCTS_SERVICES (and CREDIT), verbatim from https://developers.facebook.com/docs/marketing-api/audiences/special-ad-category — applying in the US, Canada and Europe:

- **Age:** *"Options are generally fixed to include ages 18 through 65+"* (exception: credit-opportunity ads in Europe may select a different range).
- **Gender:** *"Specific gender cannot be chosen."* Omit `genders` or send all genders.
- **Location:** *"Location exclusion is not supported."* Minimum radius *"at least 15 mile or 25 kilometer radius for the US and Canada, and 15 kilometer radius for Europe."* Prohibited location granularities: `subcity`, `neighborhood`, `metro_area`, `small_geo_area`, `subneighborhood`, `electoral_district`, `zips`.
- **Detailed targeting:** Behavior and Demographic targeting blocked; interest exclusion blocked; detailed-targeting exclusion blocked.
- **Lookalikes:** *"Lookalike audiences are unavailable for housing, employment, and financial products and services ads."*

`ISSUES_ELECTIONS_POLITICS`: no extra audience restrictions beyond standard policy, but requires authorization and a `special_ad_category_country`.

`special_ad_category_country` (list of ISO alpha-2): for issues/elections/politics it **must** be set to countries where the user and Page hold authorization. For housing/employment/financial it *"will default to your listed tax country, if it is not set"* and does not require authorization.

**v26.0 interaction (critical):** for these categories with a *constrained* audience, `targeting_automation.advantage_audience` must be explicitly `1` or `0` on ad set **creation** — omitting it now errors. (v26.0 changelog.)

Deprecated and to be removed from your code: `is_sac_cfca_terms_certified` and `is_eligible_for_sac_campaigns` (deprecated v23.0, all versions from 2025-08-27).

---

## 6. Ad Set — `POST /act_{ad_account_id}/adsets`

### 6.1 Required
- `name` (max 400 chars)
- `campaign_id`
- **either** `daily_budget` **or** `lifetime_budget` > 0 — *unless the budget is on the campaign (CBO)*, in which case you must send **neither**
- `billing_event`
- `optimization_goal`
- `targeting` — must at minimum contain `geo_locations` with a country
- `status` (`ACTIVE`|`PAUSED`) — technically optional, but always send `PAUSED` (see §11)
- `lifetime_budget` additionally **requires `end_time`**
- `promoted_object` — required for conversion/app/lead goals (see §4.3)
- `dsa_beneficiary` (+ optionally `dsa_payor`) — required for EU/EEA-targeted ad sets

Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign

### 6.2 Budget fields — units and semantics

- **Units are the ad account currency's minimum denomination**, i.e. minor units. `daily_budget: 5000` = **$50.00** for a USD account. The multiplier is the currency `offset`: USD/EUR/GBP/INR = **100**, JPY = **1** (a JPY bid of `1` really is ¥1). (https://developers.facebook.com/docs/marketing-api/currencies)
- Daily budget is an *average*. The v24.0 changelog says *"up to 75% over your daily budget may be spent on days when better opportunities are available."* **DOC CONFLICT (found 2026-09-02):** the budgets guide (https://developers.facebook.com/docs/marketing-api/bidding/overview/budgets/) **still says 25%** — *"up to 25% more than your daily budget may be spent."* The changelog is newer and more specific, so assume 75%, but build the guard tolerant of either.
- ~~"weekly spend still capped at 7× the daily budget"~~ — **UNVERIFIED 2026-09-02.** This is widely repeated but I could not find it in any developers.facebook.com page. Do not encode `7 × daily_budget` as a documented invariant; derive your own rolling-window guard from `/insights` spend instead.
- **Added 2026-09-02**, from the ad set node: `daily_budget` is *"allowed only for ad sets with a duration (difference between `end_time` and `start_time`) longer than 24 hours."* A same-day flight must use `lifetime_budget`.
- `lifetime_budget` requires `end_time`; spend is paced across the flight.
- Ad-set spend guards under a campaign budget: `daily_min_spend_target`, `daily_spend_cap` (require a **daily** budget on the campaign), `lifetime_min_spend_target`, `lifetime_spend_cap` (require a **lifetime** budget on the campaign). Min-spend targets are *"best effort"*, not guaranteed. Set a cap field to **`922337203685478`** to remove it.
- `pacing_type` — list<string>, standard vs. ad-scheduling pacing.

### 6.3 Minimum budgets — query them, don't hard-code them

The authoritative programmatic source is `GET /act_{ad_account_id}/minimum_budgets` (optional `bid_amount` param), returning `MinimumBudget` nodes:

| Field | Meaning |
|---|---|
| `currency` | currency these minimums pertain to |
| `min_daily_budget_imp` | *"The minimum daily budget for an ad set optimized for impressions"* |
| `min_daily_budget_high_freq` | lowest daily budget for frequent actions (clicks, likes) |
| `min_daily_budget_low_freq` | lowest daily budget for infrequent actions (app installs, offer claims) |
| `min_daily_budget_video_views` | minimum daily budget for video-view optimization |

(https://developers.facebook.com/docs/marketing-api/reference/ad-account/minimum_budgets/ , https://developers.facebook.com/docs/marketing-api/reference/minimum-budget/)

Also on the AdAccount node: `min_daily_budget` and `min_campaign_group_spend_cap`. **[SECONDARY]** commonly cited USD values are **$1.00/day** for impression-optimised and **$5.00/day** for click/conversion (low-frequency) optimised ad sets (e.g. https://www.stackmatix.com/blog/facebook-ads-minimum-budget-requirements). Treat those as sanity-check defaults only; **fetch `/minimum_budgets` at account-onboarding time and cache per currency.**

**What happens if you go under:** the create call fails with a budget error, not a warning. Known codes **[SECONDARY]** `1885272` / `1885650` — "Budget is too low" (https://developers.facebook.com/docs/marketing-api/error-reference/). Under CBO, the campaign daily budget must clear the per-ad-set minimum times the number of ad sets — **UNVERIFIED** as an exact documented formula, but it is the observed behaviour and worth asserting in your pre-flight validator.

`spend_cap` on the campaign has its own floor: **minimum $100 USD** or local equivalent.

### 6.4 bid_strategy and bid_amount

Enum: `LOWEST_COST_WITHOUT_CAP` (auto-bid, no cap), `LOWEST_COST_WITH_BID_CAP` (requires `bid_amount`), `COST_CAP` (requires `bid_amount` = target cost per result), `LOWEST_COST_WITH_MIN_ROAS` (requires a ROAS floor).

`bid_amount` semantics: *"For IMPRESSION/REACH billing: per 1,000 occurrences. For other events: per occurrence."* Units are minor units (cents for USD/EUR; base units for JPY/KRW). This per-mille vs per-event split is a classic off-by-1000 bug: with `billing_event=IMPRESSIONS` a `bid_amount` of `500` is a **$5.00 CPM**, not a $5.00 CPA.

`bid_strategy` lives on the **campaign** when the budget is at campaign level, and on the **ad set** when the budget is at ad-set level. Setting it in both places, or in the wrong place, is a common `code 100`.

Advantage+ requires one of: `LOWEST_COST_WITHOUT_CAP` (recommended), `COST_CAP`, `LOWEST_COST_WITH_BID_CAP`, `LOWEST_COST_WITH_MIN_ROAS`. (https://developers.facebook.com/docs/marketing-api/advantage-campaigns/)

### 6.5 targeting spec

```json
{
  "targeting": {
    "geo_locations": {
      "countries": ["US"],
      "regions": [{"key": "4081"}],
      "cities": [{"key": "2430536", "radius": 12, "distance_unit": "mile"}],
      "zips": [{"key": "US:94304"}],
      "location_types": ["home", "recent"]
    },
    "excluded_geo_locations": { "cities": [{"key": "..."}] },
    "age_min": 25,
    "age_max": 45,
    "genders": [1],
    "interests": [{"id": "6003139266461", "name": "Movies"}],
    "behaviors": [{"id": "6002714895372", "name": "All travelers"}],
    "custom_audiences": [{"id": "6004192254512"}],
    "excluded_custom_audiences": [{"id": "6004192252847"}],
    "flexible_spec": [
      {"interests": [{"id": "..."}]},
      {"behaviors": [{"id": "..."}]}
    ],
    "exclusions": {"interests": [{"id": "..."}]},
    "locales": [5],
    "publisher_platforms": ["facebook", "instagram"],
    "facebook_positions": ["feed", "facebook_reels"],
    "instagram_positions": ["stream", "reels", "story"],
    "device_platforms": ["mobile"],
    "targeting_automation": {
      "advantage_audience": 1,
      "individual_setting": {"age": 1, "gender": 1}
    },
    "targeting_relaxation_types": {"lookalike": 1, "custom_audience": 1}
  }
}
```

Semantics that bite:
- `genders`: `1` = male, `2` = female. Omit the field entirely for all genders — **do not** send `[1,2]` under a special ad category.
- `custom_audiences` / `excluded_custom_audiences`: up to **500** each.
- `flexible_spec` is an **AND of ORs**: each element is OR'd internally, elements are AND'd with each other. Plain `interests` at top level is a pure OR. The docs note *"By default, Facebook `ORs` combinations together"* — i.e. adding more interests **widens** reach; people routinely expect the opposite.
- `targeting_relaxation_types` (`lookalike`, `custom_audience`) `1`/`0` — Advantage lookalike / Advantage custom audience expansion.
- `targeting_automation.individual_setting.{age,gender}` = 1 turns age/gender into *suggestions* rather than constraints (v23.0+): *"ads will reach people outside of the setting when it's likely to improve performance."* If your optimizer reads back the age range it set and asserts equality, this will look like data corruption.
- Interest/behavior IDs must come from the **Targeting Search API** (`/search?type=adinterest`), not from memory. Deprecated categories return `code 100 / subcode 1487694` — *"Selected targeting category is deprecated; use Targeting Search API"*. v24.0 additionally consolidated some interests: *"Certain detailed targeting interest options will not be supported for new campaigns."* Any interest ID you cache will rot; re-resolve names → IDs at build time.

### 6.6 Placements (and Advantage+ placements)

Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/placement-targeting

| Field | Values |
|---|---|
| `publisher_platforms` | `facebook`, `instagram`, `threads`, `messenger`, `audience_network` |
| `device_platforms` | `mobile`, `desktop` |
| `facebook_positions` | `feed`, `right_hand_column`, `marketplace`, `video_feeds`, `story`, `search`, `instream_video`, `facebook_reels`, `facebook_reels_overlay`, `profile_feed`, `notification` |
| `instagram_positions` | `stream`, `story`, `explore`, `explore_home`, `reels`, `profile_feed`, `ig_search`, `profile_reels` |
| `audience_network_positions` | `classic`, `rewarded_video` |
| `messenger_positions` | `sponsored_messages`, `story` |
| `threads_positions` | `threads_stream` |

Two of those are already stale relative to v26.0 (the reference page lags the changelog):
- Instagram **`explore`** — removed in v26.0; ad sets specifying it **error**. `explore_home` survives.
- Messenger **`story`** — silently removed from `messenger_positions` on v26.0 create/update; deprecation extends to all versions **2026-10-27** **[SECONDARY]** (ppc.land).
- Facebook **`video_feeds`** — delivery stopped as of v24.0; spend auto-shifts elsewhere. Still accepted, just dead.

**Advantage+ placements is the absence of placement fields.** From the Advantage+ docs: *"No placement targeting or exclusions should be set, so all available placements will be eligible."* Account-level placement exclusions are still permitted. The placement reference confirms: when a positions field is unspecified, *"Facebook considers all possible default positions for that field."*
So: `publisher_platforms`, `*_positions` and `device_platforms` must all be **absent** for `advantage_placement_state: ENABLED`. Sending `publisher_platforms: ["facebook","instagram"]` — even though that is "everything you care about" — disables Advantage+ placements and therefore disables the whole `advantage_state` (§7).

v24.0 added `placement_soft_opt_out`: allows up to 5% of spend to go to *excluded* placements when it improves performance.

### 6.7 promoted_object

Sub-fields relevant to this project (full list is ~50 fields on the ad set node):
`pixel_id`, `custom_event_type`, `custom_event_str`, `offsite_conversion_event_id`, `page_id`, `application_id`, `object_store_url`, `product_catalog_id`, `product_set_id`, `product_item_id`, `event_id`, `offline_conversion_data_set_id`, `conversion_goal_id`, `whats_app_business_phone_number_id`, `lead_ads_form_event_source_type`, `value_semantic_type`.

Typical website-purchase shape:
```json
{"promoted_object": {"pixel_id": "1234567890", "custom_event_type": "PURCHASE"}}
```
`custom_event_type` takes standard event names (`PURCHASE`, `LEAD`, `COMPLETE_REGISTRATION`, `ADD_TO_CART`, `INITIATED_CHECKOUT`, `CONTENT_VIEW`, …) — for a custom conversion use `custom_event_type: "OTHER"` plus `custom_event_str`, or `offsite_conversion_event_id`. **UNVERIFIED**: the complete 2026 `custom_event_type` enum was not retrieved.

### 6.8 attribution_spec

*"Conversion attribution spec used for attributing conversions for optimization."* Structure: list of `{event_type, window_days, weight?}` where `event_type` ∈ `CLICK_THROUGH`, `VIEW_THROUGH`, `ENGAGED_VIDEO_VIEW`; `weight` defaults to 100. Supported window lengths **vary by optimization goal and campaign objective**. (https://developers.facebook.com/docs/marketing-api/reference/ad-campaign)

```json
{"attribution_spec": [
  {"event_type": "CLICK_THROUGH", "window_days": 7},
  {"event_type": "VIEW_THROUGH",  "window_days": 1}
]}
```
Note this is the **optimization** attribution window, distinct from the **reporting** window (`action_attribution_windows` on `/insights`, default `1d_view` + `28d_click`). An autonomous optimizer that compares "what we optimized for" against "what insights reports" must keep those two straight or it will chase phantom regressions.

### 6.9 Schedule / dayparting

- `start_time`, `end_time`: ISO 8601 or UTC UNIX timestamp. `end_time` mandatory with `lifetime_budget`.
- Campaign start dates beyond **37 months** out → error `3018`.
- Error `1487033`: "Campaign end date must be in future" — cannot set a past end date on an active object.
- `adset_schedule` (dayparting): list of `{start_minute, end_minute, days, timezone_type}` where `days` is an array of `0–6` (Sunday = 0), minutes are 0-based minute-of-day (so 9:00am = 540), and `timezone_type` ∈ `USER` | `ADVERTISER` (default `USER`).

```json
{"adset_schedule": [
  {"start_minute": 540, "end_minute": 1260, "days": [1,2,3,4,5], "timezone_type": "ADVERTISER"}
]}
```
Dayparting historically requires a **lifetime** budget on the ad set — **UNVERIFIED for 2026**; test before relying on it with daily budgets.

### 6.10 EU / DSA fields

~~`dsa_beneficiary` ... (+ optionally `dsa_payor`)~~ **CORRECTED 2026-09-02: BOTH are required, not just `dsa_beneficiary`.** Verbatim from the ad set reference: *"For ad sets targeting the EU and/or associated territories, the `dsa_payor` and `dsa_beneficiary` fields are required."* (https://developers.facebook.com/docs/marketing-api/reference/ad-campaign) Both are max 512 chars. Note also that neither field is flagged `[required]` in the parameter table — the conditional requirement is prose only, so a schema-driven client will happily omit them and fail at publish time. If only `dsa_payor` is supplied, `dsa_beneficiary` is auto-filled from the account's `beneficiary_default` **[SECONDARY]**. Advertisers can save defaults at ad-account level that auto-populate. `/copies` into EU-targeted ad sets fails for the same reason.

### 6.11 Example ad set (website conversions, manual placements)

```json
POST /v26.0/act_<AD_ACCOUNT_ID>/adsets
{
  "name": "AUTO-us-25-54-purchase-v1",
  "campaign_id": "120210000000000000",
  "status": "PAUSED",
  "billing_event": "IMPRESSIONS",
  "optimization_goal": "OFFSITE_CONVERSIONS",
  "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
  "daily_budget": 5000,
  "start_time": "2026-09-03T00:00:00-0700",
  "destination_type": "WEBSITE",
  "promoted_object": { "pixel_id": "1234567890", "custom_event_type": "PURCHASE" },
  "attribution_spec": [
    {"event_type": "CLICK_THROUGH", "window_days": 7},
    {"event_type": "VIEW_THROUGH", "window_days": 1}
  ],
  "targeting": {
    "geo_locations": {"countries": ["US"]},
    "age_min": 25,
    "age_max": 54,
    "publisher_platforms": ["facebook", "instagram"],
    "facebook_positions": ["feed", "facebook_reels", "story"],
    "instagram_positions": ["stream", "reels", "story"],
    "device_platforms": ["mobile", "desktop"],
    "targeting_automation": {"advantage_audience": 0}
  }
}
```

Same ad set in **Advantage+-eligible** form: delete `publisher_platforms` / `*_positions` / `device_platforms`, delete `daily_budget` (move it to the campaign), set `targeting` to `{"geo_locations":{"countries":["US"]}, "targeting_automation":{"advantage_audience":1}}`.

Ad set `effective_status`: `ACTIVE, PAUSED, DELETED, CAMPAIGN_PAUSED, ARCHIVED, IN_PROCESS, WITH_ISSUES`.

---

## 7. Advantage+ in 2026 — what actually exists now

This is the area where every pre-2026 tutorial is wrong.

### 7.1 The old API is gone

- `smart_promotion_type=AUTOMATED_SHOPPING_ADS` (Advantage+ Shopping Campaign / ASC) and the equivalent Advantage+ App Campaign (AAC) flag: *"As of v25.0, Marketing API developers will no longer be able to use the ASC API with the `smart_promotion_type=AUTOMATED_SHOPPING_ADS` field to create ASC campaigns."* (https://developers.facebook.com/docs/marketing-api/advantage-shopping-campaigns/)
- v25.0 changelog, verbatim: *"creation, duplication, and updates to Advantage+ shopping campaigns and Advantage+ app campaigns is no longer allowed"* — endpoints `POST /{ad-account-id}/campaigns` and `POST /{campaign-id}/copies`; **applied to all API versions on 2026-05-19**.
- `smart_promotion_type` is still readable and new-structure campaigns report `GUIDED_CREATION` **[SECONDARY]** (ppc.land), but it is no longer an input.

**Do not write any code that sets `smart_promotion_type`.**

### 7.2 The unified model: three levers + a read-only state

"Advantage+" is no longer a campaign *type* you request. It is an **emergent read-only property** of an ordinary campaign that happens to have all three automation levers on. Source: https://developers.facebook.com/docs/marketing-api/advantage-campaigns/

Supported objectives: `OUTCOME_SALES` (replicates ASC), `APP_INSTALLS`/app promotion (replicates AAC), `OUTCOME_LEADS` (Advantage+ leads).

The three levers, and exactly what each requires:

1. **Advantage+ audience** — at least one ad set with `targeting_automation.advantage_audience = 1`, *or* no targeting parameters except `geo_locations`, *or* individual targeting with relaxation on (Advantage lookalike / Advantage custom audience / Advantage detailed targeting / age & gender as suggestions).
2. **Advantage+ campaign budget** — budget set at the **campaign** level, with `bid_strategy` ∈ {`LOWEST_COST_WITHOUT_CAP` (recommended), `COST_CAP`, `LOWEST_COST_WITH_BID_CAP`, `LOWEST_COST_WITH_MIN_ROAS`}.
3. **Advantage+ placements** — *"No placement targeting or exclusions should be set, so all available placements will be eligible."* Account-level exclusions are allowed.

Verification read:
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
`advantage_state` values: `ADVANTAGE_PLUS_SALES`, `ADVANTAGE_PLUS_APP`, `ADVANTAGE_PLUS_LEADS`, `DISABLED` **[SECONDARY for the full enum]**. **If any single lever is `DISABLED`, the whole `advantage_state` becomes `DISABLED`.** `advantage_state` became read-only in v23.0 (`advantage_state_info` on `GET /{ad-campaign-id}` and `GET /{ad-account-id}/campaigns`).

**Design consequence:** your publisher cannot "request" Advantage+. It must (a) construct the campaign so all three levers qualify, then (b) **read back `advantage_state_info` and assert** it is not `DISABLED`. That read-back is the only reliable signal, and it belongs in your post-publish verification step.

### 7.3 Migration and the retired knob

- `POST /<CAMPAIGN_ID>/copies?migrate_to_advantage_plus=true` — **copy and migrate** (creates a new campaign).
- **Added 2026-09-02 (missed originally):** `POST /<CAMPAIGN_ID>?migrate_to_advantage_plus=true` — **migrate in place**, converting the existing campaign without creating a copy. For an autonomous system this is usually the one you want, since it preserves the campaign id your records point at.
- **Added 2026-09-02:** verbatim warning — *"migrating or migrating and copying ... will force the campaign into the learning stage."* Any optimizer that reads performance immediately after a migration is reading learning-phase noise; gate on a cooldown.
- **Exception:** campaigns using `existing_customer_budget_percentage` (the ASC "new vs existing customer budget split") *must migrate via Ads Manager, not the API*. In the new structure that control is replaced by manual segmentation across two ad sets with custom audiences **[SECONDARY]**.

### 7.4 Advantage+ audience defaults, and the v26.0 landmine

- Since v23.0, new ad sets **default to Advantage+ audience opt-in** for default/relaxed setups; you can opt out at create or update time.
- Since **v26.0**, for constrained audiences in **Housing / Employment / Financial Products** you must send `targeting_automation.advantage_audience` explicitly (`1` or `0`) on **creation** — omitting it errors. It does not apply to updates on any version. This is the single most likely thing to break a third-party tool at auto-upgrade, and it fails loudly rather than silently, which is the good outcome.

---

## 8. Ad Creative — `POST /act_{ad_account_id}/adcreatives`

Top-level parameters (https://developers.facebook.com/docs/marketing-api/reference/ad-creative/):

| Field | Notes |
|---|---|
| `name` | ≤100 chars, library name |
| `object_story_spec` | creates the unpublished page post inline — the main path for AI-generated creative |
| `object_story_id` | `{page_id}_{post_id}` of an **existing** page post — use to boost an existing post |
| `asset_feed_spec` | Dynamic Creative: multiple images/videos/bodies/titles that Meta permutes |
| `degrees_of_freedom_spec` | Advantage+ creative enhancements (see below) |
| `url_tags` | query string appended to click URLs — **this is where your UTM/tracking params go** |
| `instagram_user_id` | the IG account to run as (**replaces `instagram_actor_id`**) |
| `contextual_multi_ads` | contextual multi-ad spec |
| `call_to_action` | for ads built from an existing Instagram post |

### 8.1 object_story_spec

Fields: `page_id` (required in practice), `instagram_user_id`, and exactly one of `link_data` | `video_data` | `photo_data` | `text_data` | `template_data` | `product_data`.

**Video ad (the primary shape for this project)** — `AdCreativeVideoData`:

| Field | Notes |
|---|---|
| `video_id` | *"ID of video that user has permission to or a video in ad account video library"* — from `POST /act_{id}/advideos` |
| `image_url` **or** `image_hash` | **the thumbnail.** `image_url` is a hosted URL that gets saved to the account image library; `image_hash` refers to an already-uploaded `adimages` entry |
| `message` | *"The main body of the video post"* — the primary text |
| `title` | video title / headline. *"This cannot be used with LIKE_PAGE call to action."* |
| `link_description` | *"Overwrites the description in the video post on Facebook"* |
| `call_to_action` | `{type, value:{link, ...}}` |
| `caption_ids` | caption asset ids |
| `retailer_item_ids`, `collection_thumbnails`, `additional_image_index` | collection/DPA formats |
| `page_welcome_message` | Messenger greeting after a send-message action |
| `customization_rules_spec` | **Added 2026-09-02** — per-audience/placement creative customization rules |
| `post_click_configuration` | **Added 2026-09-02** — post-click experience config |
| `targeting` | **Added 2026-09-02** — creative-level targeting (distinct from ad set targeting) |
| `offer_id`, `branded_content_sponsor_page_id`, `branded_content_shared_to_sponsor_status`, `branded_content_sponsor_relationship` | **Added 2026-09-02** — offers and branded-content disclosure |

Two verbatim caveats missed originally: `image_url` is *"URL of image to use as thumbnail. **You should not use image URLs returned from the FB CDN**"* — so you must host your own thumbnail or use `image_hash`; and `call_to_action` is *"An optional call to action. Additionally you can specify a `LIKE_PAGE` call to action when the ad is in a `PAGE_LIKES` campaign."*

Every field on `AdCreativeVideoData` is documented as **not required** individually — the validity constraint is cross-field and is enforced at ad-creation time, not creative-creation time. That means a creative can be created successfully and only blow up when you attach it to an ad. Budget a retry/repair loop for that.

**Link/image or carousel ad** — `AdCreativeLinkData`: `link` (*"required to be the same as the CTA link url"*), `message`, `name` (headline), `description`, `caption`, `image_hash` **xor** `picture`, `call_to_action`, `child_attachments` (*"2-5 element array"*, up to 10 with `multi_share_optimized`), `multi_share_optimized` (default true — Meta reorders your carousel cards unless you set it false), `multi_share_end_card`, `attachment_style`, `app_link_spec`, `retailer_item_ids`, `page_welcome_message`.

### 8.2 call_to_action

`{"type": "<ENUM>", "value": {"link": "https://..."}}`. The `type` enum has **129+ values**; the useful ones for commerce/lead automation: `SHOP_NOW`, `LEARN_MORE`, `SIGN_UP`, `BOOK_NOW`, `GET_OFFER`, `GET_QUOTE`, `SUBSCRIBE`, `DOWNLOAD`, `ORDER_NOW`, `BUY_NOW`, `CONTACT_US`, `APPLY_NOW`, `SEE_MENU`(n/a), `WHATSAPP_MESSAGE`, `MESSAGE_PAGE`, `GET_STARTED`, `NO_BUTTON`, plus 2026 additions `SHOP_WITH_AI` and `TRY_ON_WITH_AI`. The docs warn: *"Not all types can be used for all ads."* CTA↔optimization-goal incompatibility is a real and poorly documented source of `code 100`.

For Instagram placements, if `call_to_action` is unspecified the default is `LEARN_MORE`.

### 8.3 Advantage+ creative enhancements — `degrees_of_freedom_spec`

```json
{
  "degrees_of_freedom_spec": {
    "creative_features_spec": {
      "standard_enhancements": {"enroll_status": "OPT_IN"},
      "image_touchups":        {"enroll_status": "OPT_OUT"},
      "text_optimizations":    {"enroll_status": "OPT_IN"}
    }
  }
}
```
`enroll_status` ∈ `OPT_IN` | `OPT_OUT`. The full feature key list (https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/):
`adapt_to_placement, add_text_overlay, ads_with_benefits, biz_ai, creative_stickers, customize_product_recommendation, description_automation, fb_feed_tag, fb_reels_tag, fb_story_tag, generate_cta, hide_price, ig_feed_tag, ig_reels_tag, ig_stream_tag, image_animation, image_background_gen, image_templates, image_touchups, inline_comment, local_store_extension, media_order, media_type_automation, multi_photo_to_video, music_generation, pac_relaxation, product_extensions, profile_card, profile_extension, replace_media_text, reveal_details_over_time, show_destination_blurbs, show_summary, site_extensions, standard_enhancements, standard_enhancements_catalog, text_extraction_for_headline, text_extraction_for_tap_target, text_optimizations, text_overlay_translation, text_translation, translate_voiceover, video_highlights, video_to_image, wa_mm_image_filtering, wa_mm_text_truncation_length`.

Relevant to an AI-creative platform: `adapt_to_placement` (auto-reframe for 9:16 vs 1:1 vs 4:5), `video_to_image`, `multi_photo_to_video`, `music_generation`, `translate_voiceover`, `text_translation`, `image_background_gen`. **If you are generating your own creative you probably want most of these `OPT_OUT`** so your outputs aren't silently rewritten and your A/B attribution stays clean — but `adapt_to_placement` is usually worth keeping on unless you render every aspect ratio yourself.

### 8.4 Video upload — `POST /act_{ad_account_id}/advideos`

- Simple: `source` (multipart form data) or `file_url` (a URL Meta pulls from — the cheap path when your generated video already lives in object storage), plus `title` (≤255 chars) and `name`.
- Chunked: `upload_phase` ∈ `start` | `transfer` | `finish` | `cancel`, with `file_size`, `upload_session_id`, `start_offset`/`end_offset`, `video_file_chunk`.
- Response includes `id` / `video_id`, `upload_session_id`, `success`, plus transcoding metadata (bitrate, dimension, codec, HDR).
- **Max file size and accepted formats are not stated on this endpoint page** — it defers to a separate "Video Format" doc. **UNVERIFIED.**
- **Polling for transcode completion is not documented on this page** either — **UNVERIFIED**. Historically `GET /{video_id}?fields=status` returns `{"status":{"video_status":"ready"|"processing"|"error"}}`. Creating an ad against a still-processing video is a classic intermittent failure; build a poll-until-ready gate.

### 8.5 Instagram identity — a hard 2025 deadline you must respect

Deprecated → replacement:
- `instagram_actor_id` → **`instagram_user_id`**
- `instagram_story_id` → **`source_instagram_media_id`**
- `effective_instagram_story_id` → **`effective_instagram_media_id`**

*"after September 9, 2025, there will be no Marketing API version available that supports these legacy fields."* (https://developers.facebook.com/blog/post/2025/08/11/instagram-marketing-api-update/ — note this was pulled forward from the originally announced 2026-01-21.) Affected: GET on ad sets/ads/adcreatives, `GET /generatepreviews`, POST on adcreatives, ads, async ad request sets, and adgroup `/copies`.

Also v23.0: reservation `instagram_destination_id` now returns `ig_user_id`; `instagram_actor_id` no longer works in `destination_ids`.

Related error: `1815199` — "No access to Instagram account" (ad account not authorized for that IG account).

### 8.6 Creative example

```json
POST /v26.0/act_<AD_ACCOUNT_ID>/adcreatives
{
  "name": "AUTO-creative-2026-09-02-v1",
  "object_story_spec": {
    "page_id": "<PAGE_ID>",
    "instagram_user_id": "<IG_USER_ID>",
    "video_data": {
      "video_id": "<VIDEO_ID_FROM_advideos>",
      "image_url": "https://cdn.example.com/thumbs/v1.jpg",
      "message": "Your 30-second morning routine, solved.",
      "title": "Meet the 3-in-1 serum",
      "link_description": "Free shipping over $40",
      "call_to_action": {
        "type": "SHOP_NOW",
        "value": {"link": "https://shop.example.com/serum"}
      }
    }
  },
  "degrees_of_freedom_spec": {
    "creative_features_spec": {
      "standard_enhancements": {"enroll_status": "OPT_OUT"},
      "adapt_to_placement":    {"enroll_status": "OPT_IN"}
    }
  },
  "url_tags": "utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.id}}"
}
```
`url_tags` supports Meta's dynamic macros (`{{ad.id}}`, `{{adset.name}}`, `{{campaign.name}}`, `{{placement}}`, `{{site_source_name}}`). For a self-improving system these macros are how you join Meta's `ad_id` to your own analytics without maintaining a mapping table.

---

## 9. Ad — `POST /act_{ad_account_id}/ads`

| Parameter | Type | Required |
|---|---|---|
| `name` | string | **yes** |
| `adset_id` | int64 | **yes** on creation (optional only if you inline an `adset_spec`) |
| `creative` | AdCreative | **yes** — either `{"creative_id": "<ID>"}` or an inline creative spec |
| `status` | `ACTIVE`\|`PAUSED`\|`DELETED`\|`ARCHIVED` | no |
| `conversion_domain` | string | **conditionally required** |
| `tracking_specs` | object | no |
| `adlabels`, `audience_id`, `execution_options`, `date_format`, `source_ad_id`, `engagement_audience`, `priority` | — | no |
| `bid_amount` | int | **deprecated at ad level — set it on the ad set** |

Source: https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads/ and https://developers.facebook.com/docs/marketing-api/reference/adgroup/

**`conversion_domain`**: *"the domain where conversions happen"*, required *"when creating or updating an ad in a campaign that shares data with a pixel."* Must be *"only the first and second level domains, and not the full URL. For example `facebook.com`."* Sending `https://shop.example.com/serum` instead of `example.com` is a rejection. Meta auto-populates it for existing ads by inferring from destination URLs, but **on create you must supply it** for any pixel-optimized campaign.

```json
POST /v26.0/act_<AD_ACCOUNT_ID>/ads
{
  "name": "AUTO-ad-2026-09-02-v1",
  "adset_id": "120210000000000001",
  "creative": {"creative_id": "120210000000000002"},
  "conversion_domain": "example.com",
  "status": "PAUSED"
}
```

Documented error codes on this endpoint: `100`, `105` ("The number of parameters exceeded the maximum for this operation"), `190`, `194` ("Missing at least one required parameter"), `200`, `368` ("The action attempted has been deemed abusive or is otherwise disallowed"), `500` ("Message contains banned content"), `613`, `2635`, `80004`.

`368` and `500` are the ones an autonomous system will hit that a human wouldn't: `500` fires on ad copy containing prohibited content, and `368` fires when Meta's abuse heuristics decide your app is creating objects too aggressively. Both need to route into a "quarantine this generated creative and try the next variant" path, not a blind retry.

---

## 10. Publishing state machine

### 10.1 `status` vs `effective_status`

`status` is **what you set**. `effective_status` is **the resolved delivery state**, incorporating parents and review. They are different fields; only `status` is writable.

| Level | `effective_status` enum |
|---|---|
| Campaign | `ACTIVE, PAUSED, DELETED, ARCHIVED, IN_PROCESS, WITH_ISSUES` |
| Ad Set | `ACTIVE, PAUSED, DELETED, CAMPAIGN_PAUSED, ARCHIVED, IN_PROCESS, WITH_ISSUES` |
| **Ad** | `ACTIVE, PAUSED, DELETED, PENDING_REVIEW, DISAPPROVED, PREAPPROVED, PENDING_BILLING_INFO, CAMPAIGN_PAUSED, ARCHIVED, ADSET_PAUSED, IN_PROCESS, WITH_ISSUES` |

**All review-related states exist only at the Ad level.** A perfectly healthy campaign and ad set tell you nothing about whether the creative was approved. Your poller must read `effective_status` on **ads**.

The status-management guide additionally lists a "live status" vocabulary that includes `CREDIT_CARD_NEEDED`, `DISABLED`, `PENDING_PROCESS` (https://developers.facebook.com/documentation/ads-commerce/marketing-api/best-practices/manage-your-ad-object-status). Treat your state machine as tolerant of unknown strings — Meta adds values without notice.

Interpretation:
- `PENDING_REVIEW` — in ad review. Normal after create.
- `PREAPPROVED` — approved to start on a scheduled future date.
- `DISAPPROVED` — policy rejection. Terminal until you edit the creative or appeal.
- `PENDING_BILLING_INFO` / `CREDIT_CARD_NEEDED` — the account has no valid `funding_source`. *"Ads will get no delivery"* without one.
- `IN_PROCESS` — Meta is asynchronously applying your write. Read-after-write is **not** immediately consistent.
- `WITH_ISSUES` — delivering-but-degraded, or blocked by an ad-set/campaign-level problem. Read `issues_info` for the reason.
- `CAMPAIGN_PAUSED` / `ADSET_PAUSED` — a parent is paused. Status inheritance is downward-only: pausing a campaign pauses everything under it, but un-pausing a campaign does **not** un-pause children that were individually paused.

### 10.2 `issues_info`

`GET /{ad-id}?fields=effective_status,issues_info` returns `AdCampaignIssuesInfo` nodes with:

| Field | Type | Description |
|---|---|---|
| `error_code` | int32 | "Error code for the issue" |
| `error_message` | string | "Error message for this ad set with issue" |
| `error_summary` | string | "Error summary for this ad set with issue" |
| `error_type` | string | — |
| `level` | string | "Indicate level of issue, could be ad set or campaign" |

(https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-issues-info/) All read-only. This is the machine-readable "why isn't my ad running" field and it is the correct input to an autonomous remediation loop.

**UNVERIFIED:** an `ad_review_feedback` field exists on the Ad node in older versions and returns granular policy-violation reasons; I could not confirm its 2026 shape. Test `GET /{ad-id}?fields=ad_review_feedback` empirically — if it works, it is far more actionable than `issues_info` for disapprovals.

### 10.3 Recommended publish sequence

There is **no documented Meta statement** prescribing create-paused-then-activate — it is an engineering convention, but a well-founded one given the semantics above. The reasons it is correct here:

1. Ad-set creation succeeds before the creative is validated; the creative only fully validates when the Ad is created. Creating everything `ACTIVE` means a half-built structure can start spending against a bad creative.
2. `daily_budget` starts pacing the moment the ad set is `ACTIVE`, even with zero ads.
3. `IN_PROCESS` means writes are asynchronous — you cannot assume your just-created object is fully materialised.

Sequence:
```
1. Preflight     GET  /act_{id}?fields=account_status,disable_reason,currency,timezone_id,
                                    funding_source,min_daily_budget,capabilities
                 GET  /act_{id}/minimum_budgets
                 -> abort unless account_status == 1 (ACTIVE) and funding_source present
2. Assets        POST /act_{id}/advideos   (poll until ready)
                 POST /act_{id}/adimages   (thumbnail -> image_hash)
3. Campaign      POST /act_{id}/campaigns   status=PAUSED
4. Ad Set        POST /act_{id}/adsets      status=PAUSED
5. Creative      POST /act_{id}/adcreatives
6. Ad            POST /act_{id}/ads         status=PAUSED
7. Verify        GET  /{campaign_id}?fields=advantage_state_info   (if Advantage+ intended)
                 GET  /{ad_id}?fields=effective_status,issues_info
8. Activate      POST /{campaign_id}  status=ACTIVE
                 POST /{adset_id}     status=ACTIVE
                 POST /{ad_id}        status=ACTIVE
9. Poll review   GET  /{ad_id}?fields=effective_status,issues_info
                 backoff: 1m, 2m, 5m, 15m, 30m, then hourly up to 48h
```

Review duration **[SECONDARY]**: *"Most ads are checked and approved within 24 hours"*; >48h is unusual; rare cases up to a week. Meta publishes no SLA. Your poller must therefore have a timeout policy and an escalation path, not an unbounded wait.

Steps 3–6 can be a **single batch request** with `{result=campaign:$.id}`-style dependencies, which collapses four round-trips into one — but remember it still costs four rate-limit units.

---

## 11. `/copies` — duplication semantics

`POST /{campaign_id}/copies` and `POST /{adset_id}/copies`
(https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/copies/ , https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/copies/)

| Param | Notes |
|---|---|
| `deep_copy` | bool, default `false`. *"Whether to copy all the child ads. Limits: the total number of children ads to copy should not exceed 3 for a synchronous call and 51 for an asynchronous call."* |
| `status_option` | `ACTIVE` \| `PAUSED` \| `INHERITED_FROM_SOURCE`. **Default `PAUSED`** — good default for automation. |
| `rename_options` | `{rename_strategy: DEEP_RENAME \| ONLY_TOP_LEVEL_RENAME \| NO_RENAME, rename_prefix, rename_suffix}` |
| `start_time` / `end_time` | override the child ad sets' schedule on deep copy |
| `campaign_id` (ad-set copies only) | reparent the copy into a different campaign, inheriting its settings |
| `migrate_to_advantage_plus` (campaign only) | migrate a legacy campaign to the unified Advantage+ structure |

Response: `{"copied_campaign_id": "...", "ad_object_ids": [{"source_id","copied_id","ad_object_type"}, ...]}` (ad-set variant returns `copied_adset_id`).

Gotchas:
- **The 3-child synchronous ceiling** is the one that surprises people. Anything bigger must go async.
- v25.0: `/copies` on an ASC/AAC campaign is **blocked** ("creation, duplication, and updates ... no longer allowed").
- Copying into EU-targeted ad sets fails unless payor/beneficiary are configured on the account first.
- Copies set `source_campaign_id` / `source_ad_id` on the new object — useful lineage for a self-improving system that needs to know which variant descended from which.

For an autonomous optimizer, `/copies` with `rename_options` + `status_option=PAUSED` is the natural "spawn a variant" primitive: it preserves everything you didn't intend to change, which is far safer than reconstructing an ad set from your own stored spec and accidentally dropping a field.

---

## 12. Campaign budget (CBO / Advantage campaign budget) vs ad-set budget

| | Campaign-level budget | Ad-set-level budget |
|---|---|---|
| Where | `daily_budget`/`lifetime_budget` on the **campaign** | on the **ad set** |
| Also called | CBO → "Advantage campaign budget" | ABO |
| `bid_strategy` lives on | campaign | ad set |
| Per-ad-set control | `daily_min_spend_target` / `daily_spend_cap` (needs campaign **daily** budget); `lifetime_min_spend_target` / `lifetime_spend_cap` (needs campaign **lifetime** budget) | n/a |
| Advantage+ eligible | **yes — required** | no (`advantage_budget_state: DISABLED`) |
| v24.0 obligation | — | must set `is_adset_budget_sharing_enabled` on the campaign |

CBO is **not** hard-enforced — you can still put budgets on ad sets. But:
- It is a **precondition for `advantage_state != DISABLED`** (§7.2).
- Since v24.0 you must declare `is_adset_budget_sharing_enabled` at campaign creation if you intend to use ad-set budgets, and *"Setting it to true is recommended in order to turn on this optimization"* — up to **20% budget sharing between ad sets**, which is effectively a soft CBO.

**Recommendation for this platform: default to campaign-level budget.** It is the only path to Advantage+, it removes an entire class of "which ad set gets the money" logic from your optimizer, and it matches where Meta is pushing. Reserve ad-set budgets for deliberate hold-out/experiment structures, and when you do, always send `is_adset_budget_sharing_enabled` explicitly.

You may not set both a campaign budget and ad-set budgets in the same campaign.

---

## 13. Error reference for publishing

| Code | Subcode | Meaning / practical cause |
|---|---|---|
| `100` | — | "Invalid parameter". The catch-all. **Most illegal objective/optimization_goal/billing_event/destination_type tuples land here** with an unhelpful message. Always log `error_user_title`, `error_user_msg`, `error_subcode`, and `fbtrace_id`. |
| `100` | `1487694` | Deprecated targeting category — re-resolve via Targeting Search API |
| `100` | `33` | "Unsupported post request" — token lacks system-user permissions (common with Custom Audiences) |
| `105` | — | Too many parameters for the operation |
| `190` | — | Invalid/expired OAuth token → refresh flow |
| `194` | — | Missing at least one required parameter |
| `200` | — | Permission error — user lacks the ad-account task, or app lacks `ads_management` |
| `200` | `1870034` | Custom Audience terms not accepted |
| `294` | — | *"Managing advertisements requires..."* — app not allowlisted / missing `ads_management` |
| `368` | — | "The action attempted has been deemed abusive or is otherwise disallowed" — anti-abuse trip; **back off hard, do not retry tightly** |
| `500` | — | "Message contains banned content" — the generated ad copy violates policy |
| `613` | `1487742` | Ad-account call rate limit |
| `17` | `2446079` | User request limit |
| `80004` | — | Business-use-case rate limit |
| `801` | — | Invalid operation |
| `1487033` | — | "Campaign end date must be in future" |
| `1487056` | — | "Ad set has been deleted..." — only `name` editable; duplicate to change anything else |
| `1815199` | — | No access to the specified Instagram account |
| `1870090` | — | Must agree to Custom Audience terms |
| `1885272` / `1885650` | — | "Budget is too low" **[SECONDARY]** |
| `2500` | — | Graph query parse error (malformed `fields`) |
| `2635` | — | Deprecated API version |
| `3018` | — | Start date more than 37 months out |

Source: https://developers.facebook.com/docs/marketing-api/error-reference/ plus the per-endpoint error tables.

**Retry taxonomy for an autonomous system:**
- Retry with backoff: `17`, `613`, `80004`, `1` / `2` transient
- Refresh token then retry once: `190`
- Do **not** retry; escalate/quarantine: `100`, `194`, `200`, `294`, `368`, `500`, `2635`, `3018`, budget-too-low
- `368` specifically should trip a circuit breaker on that ad account for hours.

---

## 14. Gotchas

1. **Node names lie.** `ad-campaign` is the Ad Set doc; `adgroup` is the Ad doc; `ad-campaign-group` is the Campaign doc.
2. **`special_ad_categories` is required and must be an array.** `[]` for normal ads. This is the single most common first-call failure.
3. **Budgets are minor units.** `daily_budget: 50` is 50 **cents**, not $50. And JPY has offset 1, so the same code path must not blanket-multiply by 100 — read `currency` and the offset table.
4. **Daily budget can overspend by 75% on a single day** (v24.0, up from 25%). Weekly cap is 7× daily. Any "did we overspend?" alarm keyed to a single day will fire constantly and be wrong.
5. **`bid_amount` is per-1000 for IMPRESSIONS/REACH billing, per-event otherwise.** Off-by-1000 bugs are silent and expensive.
6. **Advantage+ placements = sending *no* placement fields.** Explicitly listing "all" the platforms disables it. Likewise Advantage+ audience requires either the flag or geo-only targeting. Any one lever off → `advantage_state: DISABLED` for the whole campaign.
7. **`smart_promotion_type` is dead for creation** since v25.0 (all versions from 2026-05-19). Any code or library that sets it will fail.
8. **v26.0: `targeting_automation.advantage_audience` must be explicit** for constrained-audience Housing/Employment/Financial ad sets on create.
9. **`instagram_actor_id` no longer exists in any supported version** (since 2025-09-09). Use `instagram_user_id`, `source_instagram_media_id`, `effective_instagram_media_id`.
10. **`conversion_domain` must be the eTLD+1** (`example.com`), not a full URL and not a subdomain path.
11. **`is_adset_budget_sharing_enabled` is required at campaign creation** if you intend to set ad-set budgets (v24.0+). It's a campaign field but its trigger is an ad-set decision — easy to miss.
12. **Review state only exists on Ads.** Polling campaign/ad-set `effective_status` will report `ACTIVE` while every ad underneath is `DISAPPROVED`.
13. **`IN_PROCESS` means writes are async.** Read-after-write is not consistent. Verify, don't assume.
14. **Deleted ads keep accruing metrics for 28 days.** Use `PAUSED` as your kill switch.
15. **Targeting is OR by default.** More interests = broader, not narrower. `flexible_spec` is the AND-of-ORs construct.
16. **`multi_share_optimized` defaults true** — Meta will reorder and drop your carousel cards unless you set it false.
17. **`targeting_automation.individual_setting` turns age/gender into suggestions**, so your read-back won't match your write. Don't treat that as drift.
18. **Batching doesn't save rate limit**, only round trips. Max 50 ops.
19. **Dev-tier accounts get 300 calls/hour.** Your integration tests will exhaust that.
20. **`/copies` with `deep_copy` is capped at 3 children synchronously**, 51 asynchronously.
21. **`explore` (Instagram) and Messenger `story` positions now error or vanish** in v26.0; Facebook `video_feeds` accepts but doesn't deliver.
22. **Delivery Estimate lost `daily_outcomes_curve`, `budget_guardrail`, `estimate_dau` in v26.0 with no replacement.** If your optimizer planned to use forecast curves for budget planning, that data source no longer exists — you must build your own from historical `/insights`.
23. **Interest IDs rot.** v24.0 consolidated interest options; deprecated ones return `100/1487694`. Re-resolve names→IDs at publish time rather than caching.
24. **EU targeting without `dsa_beneficiary` will not publish**, and the error is a generic parameter error.
25. **`error_user_msg` is often the only useful part of a `code 100`.** Log the whole error envelope including `fbtrace_id` — Meta support requires it.

---

## 15. Open questions / UNVERIFIED

1. **`CONVERSIONS → OUTCOME_SALES` rows of the ODAX mapping table.** The canonical table truncated in retrieval before the sales block. The website-purchase tuple (`OUTCOME_SALES` + `OFFSITE_CONVERSIONS` + `IMPRESSIONS` + `pixel_id`/`PURCHASE`) is **inferred and load-bearing**. Verify on a live account first.
2. **Is `destination_type: "WEBSITE"` legal under `OUTCOME_TRAFFIC`?** The official destination-type table does not list it, yet website traffic is the objective's main use. Probably you omit the field. Needs an empirical test.
3. **Are legacy objectives (`CONVERSIONS`, `LINK_CLICKS`, `VIDEO_VIEWS`, …) still creatable in v26.0?** Still present in the enum; secondary sources say no. Not worth relying on either way — emit only `OUTCOME_*`.
4. **`VALUE` optimization goal under `OUTCOME_SALES`** and its interaction with `LOWEST_COST_WITH_MIN_ROAS` — not found in the ODAX table.
5. **Exact minimum-budget values per currency.** Only the `/minimum_budgets` field names are documented; the numbers must be fetched at runtime. The $1/$5 USD figures are secondary.
6. **CBO minimum formula.** Whether the campaign daily budget must be ≥ (per-ad-set minimum × number of ad sets) is undocumented.
7. **Video upload limits** — max file size, accepted codecs/containers, and the transcode-status polling field on `/advideos`. The endpoint page defers to a "Video Format" doc I did not retrieve.
8. **`ad_review_feedback`** field shape (or existence) on the Ad node in v26.0.
9. **Complete `custom_event_type` enum** for `promoted_object`.
10. **Dayparting (`adset_schedule`) with daily budgets** — historically lifetime-budget-only; unconfirmed for 2026.
11. **Sandbox ad accounts** — whether Meta still offers non-spending sandbox accounts and whether they honour ODAX/Advantage+ semantics.
12. **Aggregated Event Measurement.** A secondary source claims Meta removed manual AEM configuration in June 2025 and now aggregates eligible web events automatically, and that domain verification is no longer required for AEM. Not confirmed against official docs; it materially affects whether your pipeline must manage the 8-event priority list.
13. **`advantage_state` full enum** — only `ADVANTAGE_PLUS_SALES` is confirmed from official docs; `ADVANTAGE_PLUS_APP`, `ADVANTAGE_PLUS_LEADS`, `DISABLED` are secondary.
14. **`GET /act_{id}/delivery_estimate`** post-v26.0 — what remains after the three field removals, and whether it is still useful for pre-flight reach checks.

---

## 16. Source index

Official (developers.facebook.com):
- Changelog index — /docs/graph-api/changelog
- v26.0 / v25.0 / v24.0 / v23.0 — /docs/graph-api/changelog/version{26,25,24,23}.0
- Campaign node — /docs/marketing-api/reference/ad-campaign-group
- ODAX mapping table — /documentation/ads-commerce/marketing-api/reference/ad-campaign-group#odax-mapping
- Ad Set node — /docs/marketing-api/reference/ad-campaign
- Ad Set guide — /docs/marketing-api/adset/
- destination_type — /docs/marketing-api/adset/destination_type/
- Billing events — /docs/marketing-api/bidding/overview/billing-events/
- Budgets — /docs/marketing-api/bidding/overview/budgets/
- Currencies — /docs/marketing-api/currencies
- MinimumBudget — /docs/marketing-api/reference/minimum-budget/ and /docs/marketing-api/reference/ad-account/minimum_budgets/
- Ad node — /docs/marketing-api/reference/adgroup/
- Ads edge — /docs/marketing-api/reference/ad-account/ads/
- AdCreative — /docs/marketing-api/reference/ad-creative/
- object_story_spec — /docs/marketing-api/reference/ad-creative-object-story-spec/
- video_data — /docs/marketing-api/reference/ad-creative-video-data/
- link_data — /docs/marketing-api/reference/ad-creative-link-data/
- call_to_action — /docs/marketing-api/reference/ad-creative-link-data-call-to-action/
- creative features — /docs/marketing-api/reference/ad-creative-features-spec/
- advideos — /docs/marketing-api/reference/ad-account/advideos/
- AdAccount — /docs/marketing-api/reference/ad-account/
- Special ad category — /docs/marketing-api/audiences/special-ad-category
- Placement targeting — /documentation/ads-commerce/marketing-api/audiences/reference/placement-targeting
- Targeting specs — /docs/marketing-api/targeting-specs
- Advantage+ campaigns — /docs/marketing-api/advantage-campaigns/
- Advantage+ shopping deprecation — /docs/marketing-api/advantage-shopping-campaigns/
- Campaign /copies — /docs/marketing-api/reference/ad-campaign-group/copies/
- Ad Set /copies — /docs/marketing-api/reference/ad-campaign/copies/
- Issues info — /docs/marketing-api/reference/ad-campaign-issues-info/
- Object status best practice — /documentation/ads-commerce/marketing-api/best-practices/manage-your-ad-object-status
- Error reference — /docs/marketing-api/error-reference/
- Rate limiting — /docs/marketing-api/overview/rate-limiting
- Authorization — /docs/marketing-api/overview/authorization
- Batch requests — /docs/graph-api/batch-requests
- Instagram field deprecation — /blog/post/2025/08/11/instagram-marketing-api-update/

Secondary (used only where labelled):
- https://ppc.land/meta-blocks-47-commerce-endpoints-as-graph-api-v26-0-lands-today/
- https://ppc.land/meta-launches-unified-api-structure-for-advantage-campaigns/
- https://ppc.land/meta-deprecates-legacy-campaign-apis-for-advantage-structure/
- https://www.stackmatix.com/blog/facebook-ads-minimum-budget-requirements

---

## 17. Fact-check log — 2026-09-02 (adversarial review)

18 load-bearing claims were re-checked against `developers.facebook.com` primary pages. Verdicts below. Where a claim was wrong, the body of this document has been edited in place and the change is marked `CORRECTED 2026-09-02` / `Added 2026-09-02`.

### Refuted / corrected

| # | Claim as written | Verdict | Correct fact | Source |
|---|---|---|---|---|
| 1a | v23.0 "available until 2026-06-09 — already expired" | **REFUTED** | v23.0 is available until **2027-10-08** and is not expired. The oldest still-usable version as of 2026-09-02 is **v20.0**, which expires 2026-09-24. | https://developers.facebook.com/docs/graph-api/changelog |
| 1b | "Unversioned calls resolve to the oldest non-expired version" | **REFUTED** | Unversioned calls use *"the version set in the app dashboard Upgrade API Version card under Settings > Advanced."* The oldest-usable fallback only applies **after a version expires**. | https://developers.facebook.com/docs/graph-api/guides/versioning |
| 7 | ODAX mapping table "only reachable via the `/documentation/ads-commerce/...` mirror, not `/docs/marketing-api/...`" | **REFUTED** | The Objective Mapping table is on the ordinary `/docs/marketing-api/reference/ad-campaign-group` page, under "Outcome-Driven Ads Experiences Objective Validation → Objective Mapping". The mirror is the same content. | https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group |
| 8 | "The `CONVERSIONS → OUTCOME_SALES` rows truncated in retrieval" | **REFUTED (worse than stated)** | `OUTCOME_SALES` **does not appear as a target objective anywhere** in the Objective Mapping table on either URL. It is a documentation hole, not truncation. The `PRODUCT_CATALOG_SALES → OUTCOME_SALES` row listed in §4.3 is therefore **not** a quoted row and must be dropped from any "verbatim" framing. | both URLs above |
| 18 | "`dsa_beneficiary` (and optionally `dsa_payor`)" | **REFUTED (partial)** | Verbatim: *"For ad sets targeting the EU and/or associated territories, the `dsa_payor` **and** `dsa_beneficiary` fields are required."* **Both.** 512-char limits confirmed. | https://developers.facebook.com/docs/marketing-api/reference/ad-campaign |
| 9c | "weekly still capped at 7× daily budget" | **UNVERIFIED → downgraded** | Not present on any developers.facebook.com page I could retrieve. Additionally the budgets guide **still states 25%**, conflicting with the v24.0 changelog's 75%. Do not encode 7× as a documented invariant. | https://developers.facebook.com/docs/marketing-api/bidding/overview/budgets/ vs /docs/graph-api/changelog/version24.0 |
| 15b | Throttle code list (`17`, `613`, `80004` only) | **INCOMPLETE** | Also documented: `613` subcodes `5044001`, `1487632`, `1487225`; error `4` subcodes `1504022`, `1504039`; BUC errors `80000`, `80003`, `80014`. | https://developers.facebook.com/docs/marketing-api/overview/rate-limiting |

### Confirmed against primary sources

| # | Claim | Verdict | Source |
|---|---|---|---|
| 1c | v26.0 released 2026-07-29; v25.0 2026-02-18 (until 2028-07-29); v24.0 2025-10-08 (until 2028-02-18); error `2635` = "You are calling a deprecated version of the Ads API." | **CONFIRMED** | /docs/graph-api/changelog ; /docs/marketing-api/reference/ad-account/ads/ |
| 2 | ASC/AAC cannot be created, duplicated or updated via API; verbatim changelog wording; endpoints `POST /{ad-account-id}/campaigns` + `POST /{campaign-id}/copies`; extended to all versions **2026-05-19**; `smart_promotion_type=AUTOMATED_SHOPPING_ADS` dead for creation | **CONFIRMED** (both the v25.0 changelog and the ASC page) | /docs/graph-api/changelog/version25.0 ; /docs/marketing-api/advantage-shopping-campaigns/ |
| 3 | Advantage+ = emergent read-only property; objectives `OUTCOME_SALES` / `APP_INSTALLS` / `OUTCOME_LEADS`; three levers exactly as described; `advantage_state_info` sub-fields; any lever off ⇒ `DISABLED`; `advantage_state` enum incl. `ADVANTAGE_PLUS_APP` / `ADVANTAGE_PLUS_LEADS` (**now primary, no longer [SECONDARY]**) | **CONFIRMED** | /docs/marketing-api/advantage-campaigns/ |
| 4 | v26.0 requires explicit `targeting_automation.advantage_audience` on HEC-F ad set **creation** only | **CONFIRMED** — and sharpened: applies to *"relaxable targeting in a non-broad setup"*; *"Broad or default audience setups are unaffected"*; omitting returns `ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG` (a named error, not a bare code 100 — worth matching on) | /docs/graph-api/changelog/version26.0 |
| 5 | `destination_type` legality table per objective, all six rows | **CONFIRMED verbatim**, incl. the two traps (`OUTCOME_TRAFFIC` omits `WEBSITE`; `OUTCOME_SALES` omits `UNDEFINED`) | /docs/marketing-api/adset/destination_type/ |
| 6 | `IMPRESSIONS` legal for every optimization goal; only `LINK_CLICKS`, `THRUPLAY`, `TWO_SECOND_CONTINUOUS_VIDEO_VIEWS` accept anything else; buying_type table | **CONFIRMED verbatim** (doc adds: for `POST_ENGAGEMENT`, the `POST_ENGAGEMENT` billing event is unavailable as of v2.11) | /docs/marketing-api/bidding/overview/billing-events/ |
| 9a/9b | Currency offsets USD/EUR/GBP/INR = 100, JPY = 1 (KRW also 1); `bid_amount` *"for ads with `IMPRESSION` or `REACH` as `billing_event` is per 1,000 occurrences ... and for ads with other `billing_event`s is for each occurrence"* | **CONFIRMED verbatim** | /docs/marketing-api/currencies ; /docs/marketing-api/reference/ad-campaign |
| 10 | `MinimumBudget` fields `currency`, `min_daily_budget_imp`, `min_daily_budget_high_freq`, `min_daily_budget_low_freq`, `min_daily_budget_video_views`; edge takes optional `bid_amount`; `spend_cap` *"minimum value of $100 USD (or approximate local equivalent)"* | **CONFIRMED verbatim** | /docs/marketing-api/reference/minimum-budget/ ; /docs/marketing-api/reference/ad-campaign-group/ |
| 11 | `is_adset_budget_sharing_enabled` required (v24.0) when budgets go on ad sets; up to 20% sharing | **CONFIRMED verbatim** — changelog: *"is now required if you are planning to set a budget at the ad set level"*; node: *"advertisers can now share up to 20% of their budget with other ad sets in the same campaign"* | /docs/graph-api/changelog/version24.0 ; /docs/marketing-api/reference/ad-campaign-group/ |
| 12 | Review states exist only on the Ad; all three `effective_status` enums exactly as listed | **CONFIRMED verbatim**, all three | /docs/marketing-api/reference/adgroup/ ; .../ad-campaign ; .../ad-campaign-group/ |
| 13 | `conversion_domain` is eTLD+1 | **CONFIRMED verbatim**: *"Required to create or update an ad in a campaign that shares data with a pixel... should contain only the first and second level domains, and not the full URL. For example `facebook.com`."* Also confirmed: `bid_amount` is **Deprecated** at ad level. | /docs/marketing-api/reference/adgroup/ |
| 14 | `instagram_actor_id` → `instagram_user_id`, `instagram_story_id` → `source_instagram_media_id`, `effective_instagram_story_id` → `effective_instagram_media_id`; *"after September 9, 2025, there will be no Marketing API version available"* | **CONFIRMED verbatim** | /blog/post/2025/08/11/instagram-marketing-api-update/ |
| 15a | Rate-limit formula *"(100000 if your app is in the Marketing API Full access or 300 if your app is in the Dev tier) + 40 * Num of Active ads"*; Full Access = 500+ calls in 15 days, <15% error rate over last 500 | **CONFIRMED verbatim** | /docs/marketing-api/overview/rate-limiting |
| 16 | `special_ad_categories` required array; full enum; every HEF restriction quoted (18–65+, no gender, no location exclusion, 15mi/25km US-CA and 15km EU, the seven banned granularities, behavior/demographic blocked, interest + detailed-targeting exclusion blocked, *"Lookalike audiences are unavailable"*); `special_ad_category_country` *"will default to your listed tax country"* | **CONFIRMED verbatim** | /docs/marketing-api/audiences/special-ad-category ; /docs/marketing-api/reference/ad-campaign-group |
| 17 | `object_story_spec.video_data` shape and `advideos` upload (`source`/`file_url`, `upload_phase` start/transfer/finish/cancel, `upload_session_id`, offsets) | **CONFIRMED** — field list was incomplete (see §8.1 additions) | /docs/marketing-api/reference/ad-creative-video-data/ ; /docs/marketing-api/reference/ad-account/advideos/ |

### Things the original write-up missed (added to the body above)

1. **Migrate-in-place exists.** `POST /<CAMPAIGN_ID>?migrate_to_advantage_plus=true` converts a campaign without copying it — the original only documented the `/copies` variant. Migration *"will force the campaign into the learning stage"*, which matters for any optimizer reading post-migration performance.
2. **`daily_budget` is illegal on flights shorter than 24 hours** — *"allowed only for ad sets with a duration ... longer than 24 hours."* Same-day flights must use `lifetime_budget` + `end_time`.
3. **`image_url` on `video_data` must not be an FB CDN URL** — *"You should not use image URLs returned from the FB CDN."* An automation pipeline that reads a thumbnail back from Meta and re-submits it will break.
4. **Three undocumented-in-the-original `destination_type` values**: `APPLINKS_AUTOMATIC` (needs `product_set_id`) and `FACEBOOK` (Vehicle vertical only), plus a self-contradiction in the docs where `PHONE_CALL`'s requirement is stated in **legacy** objective names (`PRODUCT_CATALOG_SALES` or `CONVERSIONS`).
5. **Four `video_data` fields absent from the original table**: `customization_rules_spec`, `post_click_configuration`, `targeting` (creative-level), `offer_id`, plus the branded-content trio.
6. **The v26.0 advantage_audience failure has a named error string**, `ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG` — match on that, not on a generic `code 100`.
7. **`advantage_state` full enum is primary-sourced**, not secondary: `ADVANTAGE_PLUS_SALES`, `ADVANTAGE_PLUS_APP`, `ADVANTAGE_PLUS_LEADS`, `DISABLED`. §7.2's `[SECONDARY for the full enum]` tag can be dropped.
8. **Special ad categories additionally restrict interests to an allowlist**: *"Supported targeting interests have to be part of a previously approved list."* Your interest resolver needs a category-aware filter, not just the Targeting Search API.
9. **Rate-limit tiers carry a score model** (60-point Development vs 9000-point Standard) separate from the call-count formula.
10. **Version expiry is keyed to the *next* version's release**, not its own — two years after the subsequent version ships. This changes when your upgrade job must fire.

### Still unverified after this pass

- The `OUTCOME_SALES` / website-purchase tuple (§4.3, §15 item 1). **No documented mapping row exists.** This remains the single highest-risk assumption in the document and must be settled by a live create call before anything is built on it.
- Whether `PRODUCT_CATALOG_SALES → OUTCOME_SALES` is a real row in the Objective Mapping table (retrieval truncates on the table's tail on both URLs).
- The 25% vs 75% daily-budget flexibility conflict between the budgets guide and the v24.0 changelog.
- The "weekly spend capped at 7× daily" figure — no primary source found.
- Everything already listed in §15 items 2–14, none of which this pass was able to close.
- Header naming: the rate-limiting page renders the BUC header as both `X-Business-Use-Case` and `X-Business-Use-Case-Usage`. Parse defensively.
