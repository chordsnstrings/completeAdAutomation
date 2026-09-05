# Video-View Custom Audiences & Lookalikes on Meta
**Research dossier for a fully-autonomous Meta ads platform**
Compiled 2026-09-02 against Marketing API **v26.0** (the version pinned in `src/meta/version.ts`).
Every non-obvious claim carries a source URL. Claims I could not confirm against a primary
Meta source are marked **UNVERIFIED**. Claims that come from live-verified third-party code
rather than Meta documentation are marked **CORROBORATED (non-primary)**.

> **Scope note for this repo:** everything below is a *write* surface. Under the project's
> ABSOLUTE RULE, none of it may be executed against the live account. `POST /customaudiences`
> is an ad-object write and stays behind `RUNTIME_MODE=SIMULATE`. The `GET` verification calls
> in §8 are safe and are the ones worth wiring first.

---

## 0. Executive answer

Three findings dominate everything else in this dossier, and two of them are uncomfortable.

**Finding 1 — the funnel-audience thesis is substantially weaker in 2026 than the playbook literature assumes.**
Meta has moved custom audiences and lookalikes from *constraints* to *suggestions* for most
performance goals. When Advantage+ audience is on — and it is on by default for new ad sets
since v23.0 — the audiences you attach are a **seed for expansion, not a boundary**. See §10.
The one thing that is still a hard, respected constraint is `excluded_custom_audiences`.

**Finding 2 — the video-view audience is the single highest-value audience this platform can build,
and not for targeting.** Because the system generates its own video creative, it owns the
video IDs. A video-view audience is the only first-party signal available *before* any pixel,
CRM list or purchase exists. Its real value is (a) as a **lookalike seed** to escape the
100-person cold-start, and (b) as an **exclusion** to stop re-serving the same creative.

**Finding 3 — there is a human-only gate in front of all of this.** Custom Audience Terms of
Service acceptance is per-user-per-business, UI-only, and there is **no API to grant it**. It
blocks audience creation entirely (§1). This is the same class of pending-human-step as the
"no ad accounts assigned" blocker already noted in the project state, and it should be
detected and reported by preflight rather than discovered at publish time.

**Recommended build order:** exclusions first (real constraint, real value), lookalike seeds
second, positive video-view targeting last and only as an A/B against broad.

---

## 1. THE GATE: Custom Audience Terms of Service

Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/custom-audience-terms-of-service

### 1.1 What it is

Acceptance is scoped **per user, per business** — not per ad account. The business must own at
least one ad account, and the accepting user must have a role in that account. Acceptance is
performed **in the Meta UI only**; there is no endpoint that grants it.

Acceptance URL a human must visit:

```
https://business.facebook.com/ads/manage/customaudiences/tos/?act=<AD_ACCOUNT_ID>
```

### 1.2 Checking acceptance programmatically (READ-ONLY — safe to run)

Business-level acceptance:

```
GET /v26.0/act_<AD_ACCOUNT_ID>?fields=tos_accepted
```

Response contains `"custom_audience_tos": 1` when signed.

User-level acceptance (the calling user):

```
GET /v26.0/act_<AD_ACCOUNT_ID>?fields=user_tos_accepted
```

Also returns `"custom_audience_tos": 1` when that user has signed.

> **Critical for this project:** the docs state `user_tos_accepted` applies to **non-system
> users only**. This platform authenticates as a **system user**. So `user_tos_accepted` is
> not a usable signal for us and `tos_accepted` (business-level) is the field preflight should
> read. **UNVERIFIED:** whether a system user inherits business-level acceptance for the
> purposes of `POST /customaudiences`, or whether a *human* admin must have accepted within
> that business first. Practitioner reports strongly suggest the latter — that an agency user
> accepting on behalf of a brand does not satisfy the check and someone from the owning
> business must accept — see https://help.trafficguard.ai/en/articles/11086204-how-to-accept-facebook-s-custom-audience-terms-of-service

### 1.3 The error you get when it is not accepted

From https://developers.facebook.com/docs/marketing-api/error-reference/ :

| Code | Subcode | Title | Message |
|---|---|---|---|
| 200 | **1870034** | Custom Audience Terms Not Accepted | "You'll need to agree to the Custom Audience terms before you can create or edit an audience or an ad set." |
| 200 | **1870090** | (Custom Audience terms) | "To create or edit audience or ad set, please agree to the Custom Audience terms." |
| 200 | **1870092** | (Business Tools terms) | "To create or edit audience or ad set, please agree to the Meta Business Tools terms" |
| 200 | 1870047 | Audience Size too Low | "You cannot remove users from this audience because it will result in a low audience size and may result in under-delivery or non-delivery of your ads." |
| 2654 | 1713092 | No write permission for this ad account | "Developer making this call must have permissions for the ad account to create an audience for it." |

**Answer to the brief's specific question:** subcode **1870090 is confirmed present in the
current error reference** and is a `code 200` (permission error) subcode. Note that
**1870034 is a distinct subcode with nearly identical semantics** — the error reference lists
both. Any retry/classification logic must treat **1870034, 1870090 and 1870092** as the same
terminal, human-intervention-required class. Treating only 1870090 will let 1870034 fall
through into a generic-permission retry loop, which will never succeed.

There are **two separate terms** — Custom Audience terms (1870090/1870034) and Meta Business
Tools terms (1870092). Accepting one does not accept the other.

---

## 2. Engagement custom audiences — the general grammar

Primary sources:
- https://developers.facebook.com/docs/marketing-api/audiences/guides/engagement-custom-audiences/
- https://developers.facebook.com/docs/marketing-api/audiences/guides/audience-rules/

### 2.1 The `subtype` trap

Verbatim from the engagement guide:

> "Since September 2018, `subtype` is not supported for custom audiences for websites, apps,
> engagement custom audiences, and audiences from offline conversion data. The exception is
> that `subtype` is supported for engagement custom audiences for video."

This is a genuine footgun. For **page / IG / lead-form / instant-experience** engagement
audiences you must **omit `subtype` entirely**. Sending it produces a misleading
`#2654 Invalid event name` error rather than an "unsupported field" error.
**CORROBORATED (non-primary):** this exact failure mode and its misleading error text are
documented in live-verified production code at
https://github.com/matas-offpixel/meta-campaign-builder/blob/main/lib/meta/audience-payload.ts

For **video** engagement audiences `subtype` *is* accepted, and in practice is required (§3).

### 2.2 Rule shape

The general rule grammar (from the audience-rules guide) is:

```jsonc
{
  "inclusions": {                 // and optionally "exclusions"
    "operator": "or",             // "and" | "or"
    "rules": [
      {
        "event_sources": [ { "type": "<source type>", "id": "<object id>" } ],
        "retention_seconds": 2592000,
        "filter": {
          "operator": "and",
          "filters": [
            { "field": "event", "operator": "eq", "value": "<event name>" }
          ]
        }
      }
    ]
  }
}
```

Per the audience-rules guide, `event_sources[].id` "takes a single object id, or an array of
ids of the same type" — so multiple pages/videos can be stacked in one rule entry.

**Comparison operators** (audience-rules guide): `=`, `!=`, `>`, `>=`, `<`, `<=`,
`i_contains`, `i_not_contains`, `contains`, `not_contains`, `is_any`, `is_not_any`,
`i_is_any`, `i_is_not_any`, `i_starts_with`, `starts_with`, `regex_match`.

> **Operator gotcha:** the docs list `=` but Meta's own UI-created audiences read back with
> `"operator": "eq"`. Both are accepted for filter leaves.
> **CORROBORATED (non-primary):** verified 2026-05-07 by reading a UI-created audience back
> through the Graph API Explorer (source as above). Prefer `eq` so that a read-back diff
> against a UI-created audience does not show a spurious change.

**Aggregation types** (website audiences): `count`, `sum`, `avg`, `min`, `max`, `time_spent`,
`last_event_time_field`. **Aggregation operators**: `=`, `!=`, `>`, `>=`, `<`, `<=`,
`in_range`, `not_in_range`.

**Structural limits** (audience-rules guide): max **10 rules** per audience, max **100 filters**
per rule.

### 2.3 The `prefill` parameter

`prefill=1` backfills the audience with people who already matched the rule before the audience
existed. `prefill=0` starts collecting only from creation time forward. For a funnel audience
built on videos that have already been running, **`prefill=1` is what you want** — otherwise
the audience starts empty and the lookalike seed minimum (§6) is unreachable for weeks.

Lookalikes do **not** take `prefill` (they auto-refresh from the seed).

---

## 3. Video-view custom audiences — the exact shapes

This is the least-well-documented area in the entire Marketing API surface and the brief's
central question, so it gets the most careful treatment.

### 3.1 State of the documentation — read this first

**Meta has removed the video engagement audience section from the current guide.** I checked:

| URL | Result |
|---|---|
| `/docs/marketing-api/audiences/guides/engagement-custom-audiences/` | Live. Covers Page, Lead ads, Instant Experiences, IG business profiles, Shopping, AR. **No video section.** Mentions video only in the `subtype` exception note. |
| `/documentation/ads-commerce/marketing-api/audiences/guides/engagement-custom-audiences` | Same content, same omission. |
| `/docs/marketing-api/audiences-api/engagement` | Redirects to the above. Same omission. |
| `/docs/marketing-api/audiences-api/engagement/v2.8` (legacy) | **404** |
| `/docs/marketing-api/audiences/guides/video-views-custom-audiences/` | **404** |
| `/docs/marketing-api/audiences/guides/audience-rules/video-engagement` | **404** |
| `/docs/marketing-api/audiences/` index | Lists no video-audience sub-guide. |

The feature demonstrably still exists (it is present in Ads Manager and the `subtype` note
still calls it out), but **the API contract for it is currently undocumented by Meta.**
Everything in §3.2–§3.4 is therefore reconstructed from (a) surviving legacy-doc snippets,
(b) the general grammar in §2, and (c) live-verified third-party implementations. Treat this
section as the highest-risk material in the dossier and **verify by round-trip read-back**
(§3.6) before relying on it.

### 3.2 Shape A — legacy `object_id` / `event_name` bare array

This is what Meta's own legacy documentation described and what the Ads Manager UI still
produces. The surviving legacy-doc snippet reads:

> "set `subtype=ENGAGEMENT`, then write rules for the audience you want to create. Each rule
> has an `object_id`, such as video ID, and `event_name`."

The `rule` here is a **bare JSON array**, not an `{inclusions: ...}` object, and retention is
carried at the top level as `retention_days` rather than inside the rule.

```bash
curl -X POST \
  -F 'name=VV95 · brand-x · hero-cut-3' \
  -F 'subtype=ENGAGEMENT' \
  -F 'retention_days=365' \
  -F 'rule=[
        {"event_name":"video_completed","object_id":"<VIDEO_ID_1>","context_id":"<PAGE_ID>"},
        {"event_name":"video_completed","object_id":"<VIDEO_ID_2>","context_id":"<PAGE_ID>"}
      ]' \
  -F 'prefill=1' \
  -F 'access_token=<TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/customaudiences
```

Notes on Shape A, all **CORROBORATED (non-primary)** from live read-back of UI-created
audiences on 2026-05-07 (source: matas-offpixel/meta-campaign-builder, `lib/meta/audience-payload.ts`):

- `context_id` is the **Facebook Page ID that published the video** — *not* the ad account ID.
  Omitting it is a common failure.
- One array entry **per video**, each repeating the same `event_name`.
- The audience registers with `subtype=ENGAGEMENT` and
  `data_source.sub_type=ENGAGEMENT_EVENTS` even though `VIDEO` exists elsewhere as an enum.
- If `retention_days` is omitted, Meta defaults to **730 days**.

### 3.3 Shape B — modern `event_sources` grammar

This is the §2.2 grammar applied to a `video` event source. It is consistent with the
documented statement that `event_sources` carries "the type and id of the engagement object",
and is what independent implementations use:

```jsonc
{
  "inclusions": {
    "operator": "or",
    "rules": [
      {
        "event_sources": [
          { "id": "<VIDEO_ID_1>", "type": "video" },
          { "id": "<VIDEO_ID_2>", "type": "video" }
        ],
        "retention_seconds": 2592000,
        "filter": {
          "operator": "and",
          "filters": [
            { "field": "event", "operator": "eq", "value": "video_view_25_percent" }
          ]
        }
      }
    ]
  }
}
```

Posted as:

```bash
curl -X POST \
  -F 'name=VV25 · brand-x · 30d' \
  -F 'rule=<the JSON above, stringified>' \
  -F 'prefill=1' \
  -F 'access_token=<TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/customaudiences
```

**CORROBORATED (non-primary):** https://github.com/Cjota221/vexxcrm `src/lib/services/meta-publicos-cj.service.ts`
uses exactly this shape with `type: 'video'`.

**UNVERIFIED:** whether Shape B is accepted by v26.0, and if so whether `subtype` must be
omitted (per the Sep-2018 rule) or set to `ENGAGEMENT` (per the video exception). The two
documented statements are in direct tension for this case. **Shape A is the safer default**
because it is the one the legacy documentation actually described and the one Meta's own UI
produces.

### 3.4 The threshold → `event_name` mapping (the contested part)

Meta's Ads Manager exposes these video-engagement thresholds:
**3 seconds, ThruPlay, 25%, 50%, 75%, 95%.**
(Corroborated across sources; ThruPlay is defined by Meta as watching to completion or at
least 15 seconds, whichever comes first —
https://www.facebook.com/business/help/259313030934362 for the 95% metric definition.)

The percentage event names are consistently reported as:

| Threshold | `event_name` | Confidence |
|---|---|---|
| 25% | `video_view_25_percent` | Two independent implementations agree |
| 50% | `video_view_50_percent` | Two independent implementations agree |
| 75% | `video_view_75_percent` | Two independent implementations agree |
| 95% / complete | **CONTESTED — see below** | — |
| 3 seconds | **UNVERIFIED** | No source found |
| ThruPlay | **UNVERIFIED** | No source found |

**The 95% conflict — resolve this before building.** Two live-verified implementations disagree:

- `Cjota221/vexxcrm` maps `95 → "video_view_95_percent"`.
- `matas-offpixel/meta-campaign-builder` maps `95 → "video_completed"` and carries an explicit
  comment that **Meta does NOT use `video_view_95_percent`**, citing read-back of three real
  audiences (a 95% audience returned `video_completed`; a 75% audience returned
  `video_view_75_percent`; a 50% audience returned `video_view_50_percent`).

The second is the stronger evidence — it is a read-back of what Meta itself stored, not a
guess at what to send. It also explains the asymmetry: Meta's UI labels the top tier "95%"
but stores it as a completion event. **Provisional recommendation: use `video_completed` for
the top tier, and verify by read-back on the first real audience.** Note that a wrong
`event_name` surfaces as `#2654 Invalid event name`, which is at least a loud failure.

The same source also notes the docs' `video_watched_*` naming is **not** what the API actually
uses — do not reach for those names.

### 3.5 Video audience limits

**CORROBORATED (non-primary), live-verified 2026-05-21:**

- A single video-views custom audience accepts at most **200 video IDs**. Exceeding it fails
  with `#2654 subcode 1870231`: *"Video engagement audience too big: contains N videos,
  maximum limit is 200."* Split into multiple ≤200-video audiences and OR them together at
  ad-set targeting time.
- Related but distinct: a single **page**-engagement audience accepts at most **5** stacked
  engagement sources; a 6+-source POST fails atomically with `#200 subcode 1713153`.

Both caps matter for this platform specifically, because an autonomous creative pipeline
accumulates video IDs monotonically. A brand running for a year will blow through 200 videos.
**The audience-builder must chunk by construction, not by error handling.**

### 3.6 Verification strategy (READ-ONLY — do this first)

Because §3.2–§3.4 are reconstructed rather than documented, the correct engineering move is a
**round-trip read-back** against an audience created by hand in the UI:

```
GET /v26.0/<CUSTOM_AUDIENCE_ID>?fields=id,name,subtype,rule,retention_days,
    operation_status,delivery_status,approximate_count_lower_bound,
    approximate_count_upper_bound,data_source,time_content_updated
```

This is a `GET` and is fully permitted under the project's rules. It pins the true
`event_name` values, the true rule shape, and whether `subtype` is present — without writing
anything. Do this the moment a Page and ad account are assigned to the system user.

---

## 4. The other engagement audiences

All from https://developers.facebook.com/docs/marketing-api/audiences/guides/engagement-custom-audiences/
unless noted. Remember: **omit `subtype`** for everything in this section (§2.1).

### 4.1 Facebook Page engagement

`event_sources`: `{"type": "page", "id": "<PAGE_ID>"}`

Event names (`field: "event"`):

| `value` | Meaning |
|---|---|
| `page_engaged` | Most inclusive — anyone who engaged with the Page |
| `page_visited` | Visited the Page or profile |
| `page_liked` | Liked / followed the Page |
| `page_messaged` | Sent a message to the Page |
| `page_cta_clicked` | Clicked the Page CTA button |
| `page_or_post_save` | Saved the Page or a post |
| `page_post_interaction` | Interacted with any post or ad |

```jsonc
{
  "inclusions": {
    "operator": "or",
    "rules": [
      {
        "event_sources": [ { "id": "<PAGE_ID>", "type": "page" } ],
        "retention_seconds": 2592000,
        "filter": {
          "operator": "and",
          "filters": [ { "field": "event", "operator": "eq", "value": "page_engaged" } ]
        }
      }
    ]
  }
}
```

> **Retention gotcha (CORROBORATED, non-primary, verified 2026-05-11):** a `page_liked`
> (followers) audience **must** send `retention_seconds: 0`. It is an always-live "everyone who
> currently likes the Page" set with no rolling window, and Meta's UI disables the retention
> field for it. A non-zero value fails with `#2654 subcode 1713214 "Can't Choose Data Time Limit"`.

### 4.2 Instagram professional account engagement

`event_sources`: `{"type": "ig_business", "id": "<ID>"}`

Event names include: `ig_business_profile_all`, `ig_business_profile_engaged`,
`ig_user_messaged_business`, `ig_business_profile_visit`, `ig_ad_like`, `ig_organic_comment`.

> **Two gotchas here.** First, **CORROBORATED (non-primary), verified 2026-05-07:** the ID
> placed in an `ig_business` event source can be the **Facebook Page ID**, not the IG account
> ID — the IG rule "wraps the same IDs in an `ig_business` event source". Second, the
> IG-followers event is `INSTAGRAM_PROFILE_FOLLOW` — **uppercase**, uniquely among these
> constants. Do not lowercase-normalise event names.
>
> Note also that `IG_BUSINESS` appears in the `subtype` enum (§5.2), which contradicts the
> blanket "omit subtype" rule. **UNVERIFIED** which wins for IG engagement audiences.

### 4.3 Lead generation forms

Event names: `lead_generation_opened`, `lead_generation_dropoff`, `lead_generation_submitted`.

`lead_generation_opened` minus `lead_generation_submitted` (inclusion + exclusion) is the
classic "opened the form but didn't finish" retargeting segment, and it is one of the few
funnel audiences that still earns its keep in 2026 because the exclusion half is a hard
constraint (§10).

**Retention cap for lead ads is 90 days** — much shorter than everything else. See §4.6.

### 4.4 Instant Experience / Canvas

Event names: `instant_shopping_document_open`, `instant_shopping_element_click`,
`instant_shopping_did_scroll`.

### 4.5 Shopping and AR

Covered on the same page with their own event sets; retention caps in §4.6.

### 4.6 Retention caps by engagement type

Verbatim figures from the engagement guide:

| Engagement type | Max retention |
|---|---|
| Facebook Page | 31,536,000 s (documented as 730 days) |
| Instagram business profile | 63,072,000 s (730 days) |
| Instant Experiences | 63,072,000 s (730 days) |
| **Lead ads** | **7,776,000 s (90 days)** |
| Shopping | 31,536,000 s (365 days) |
| Augmented reality | 31,536,000 s (365 days) |

> **Documentation inconsistency, flagged:** 31,536,000 seconds is **365 days**, not 730.
> The guide's Page row pairs a 730-day label with a 365-day number, while IG and Instant
> Experiences pair 730 days with 63,072,000 s (which *is* 730 days). One of the Page figures
> is wrong and Meta has not corrected it. **Treat 365 days as the safe Page ceiling** and let
> the API reject anything higher, rather than assuming 730 and failing at create time.
>
> Separately, the audience-rules guide states a general retention window of **1–365 days**,
> and the CustomAudience node reference states `retention_days` accepts **1–180**. These three
> ranges do not reconcile. **UNVERIFIED** which binds in v26.0. Safest portable ceiling: **180 days**
> for anything using top-level `retention_days`; 365 for rule-level `retention_seconds`.

### 4.7 Per-account cap

**Maximum 500 engagement custom audiences per ad account.** With multi-brand × multi-video ×
multi-threshold combinatorics and the 200-video chunking rule from §3.5, this ceiling is
reachable faster than it looks. Budget it: 5 thresholds × 4 retention windows × 25 brands
= 500 exactly. The audience layer needs a garbage collector, not just a creator.

---

## 5. Custom Audience node: fields and enums

Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/custom-audience
and https://developers.facebook.com/docs/marketing-api/reference/custom-audience/

### 5.1 Fields that matter for automation

| Field | Type | Notes |
|---|---|---|
| `id` | numeric string | |
| `account_id` | numeric string | |
| `name`, `description` | string | |
| `approximate_count_lower_bound` | integer | Meta stopped exposing exact counts; you get a band |
| `approximate_count_upper_bound` | integer | |
| `retention_days` | int32 | Docs on this node say **1–180 days** (see §4.6 conflict) |
| `rule` | string | JSON-encoded |
| `rule_aggregation` | string | |
| `subtype` | enum | §5.2 |
| `operation_status` | CustomAudienceStatus | **poll this** — §8 |
| `delivery_status` | CustomAudienceStatus | **poll this** — §8 |
| `lookalike_spec` | LookalikeSpec | populated only when `subtype=LOOKALIKE` |
| `lookalike_audience_ids` | list<numeric string> | **the reverse index** — lookalikes generated *from* this audience |
| `time_created`, `time_updated` | uint32 | |
| `time_content_updated` | uint32 | "Last update of people in this custom audience" — the freshness signal |
| `customer_file_source` | enum | `USER_PROVIDED_ONLY`, `PARTNER_PROVIDED_ONLY`, `BOTH_USER_AND_PARTNER_PROVIDED` |
| `fields_violating_integrity_policy` | list<string> | |
| `opt_out_link` | string | |

`lookalike_audience_ids` is worth calling out: it means you never need to maintain your own
seed→lookalike mapping table. Read it off the seed.

### 5.2 `subtype` enum

Documented values (the two reference pages give overlapping lists):

`CUSTOM`, `LOOKALIKE`, `IG_BUSINESS`, `FB_EVENT`, `IG_BUSINESS_EVENTS`, `FB_EVENT_SIGNALS`,
`MULTI_DATA_EVENTS`, `MULTI_DATA`, `EXPERIMENTAL`, `CLAIM`

> **`ENGAGEMENT` is not in the documented enum**, yet it is what the legacy video docs
> instruct you to send and what UI-created video audiences read back as. Another symptom of
> §3.1's documentation rot. Send it for video anyway; verify by read-back.

### 5.3 POST creation parameters

`name`, `description`, `subtype`, `opt_out_link`, `rule`, `rule_aggregation`, `lookalike_spec`
(JSON-encoded string), `origin_audience_id`, `customer_file_source`, `claim_objective`,
`content_type`, `event_source_group`, `event_sources`, `product_set_id`, `allowed_domains`,
`enable_fetch_or_create`, `use_for_products` (list of `ADS`, `MARKETING_MESSAGES`),
`use_in_campaigns`, `prefill`, `retention_days`, `is_value_based`.

**New in 2026:** `audience_labels`, added **2026-04-30**, for Customer File / Website / Mobile
App custom audiences — categorisation such as `HIGH_VALUE_CUSTOMERS` or `QUALIFIED_LEADS`,
"so they can be found and used for your ads more effectively." Affects
`POST /{ad-account-id}/customaudiences`.
Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026
(**UNVERIFIED** whether engagement/video audiences accept it.)

### 5.4 Data source enums (read-only diagnostics)

From https://developers.facebook.com/docs/marketing-api/reference/custom-audience-data-source/

`type`: `UNKNOWN` ("when an audience is created and before uploading any content"),
`FILE_IMPORTED`, `EVENT_BASED`, `SEED_BASED` ("lookalike audience"), `THIRD_PARTY_IMPORTED`,
`COPY_PASTE`, `CONTACT_IMPORTER`, `HOUSEHOLD_AUDIENCE`.

`sub_type` (relevant subset): **`VIDEO_EVENTS`** — "Reports from video views, e.g. 3% or 95% of
video has been watched" — plus `VIDEO_EVENT_USERS`, `ENGAGEMENT_EVENT_USERS`, `PAGE_FANS`,
`IG_BUSINESS_EVENTS`, `IG_PROMOTED_POST`, `CONVERSION_PIXEL_HITS`, `CAMPAIGN_CONVERSIONS`,
`OFFLINE_EVENT_USERS`, `MESSAGE_CAMPAIGN`.

`data_source.sub_type == VIDEO_EVENTS` is a clean programmatic way to identify video audiences
without parsing `rule`.

---

## 6. Lookalike audiences

Primary source: https://developers.facebook.com/docs/marketing-api/audiences/guides/lookalike-audiences/

### 6.1 Minimal creation

```bash
curl \
  -F 'name=LAL 1% US · seed VV95 brand-x' \
  -F 'subtype=LOOKALIKE' \
  -F 'origin_audience_id=<SEED_AUDIENCE_ID>' \
  -F 'lookalike_spec={"type":"similarity","country":"US"}' \
  -F 'access_token=<ACCESS_TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/customaudiences
```

Unlike engagement audiences, **`subtype=LOOKALIKE` is required** — this is the documented
exception to the Sep-2018 subtype deprecation. Lookalikes take **no `rule`** and **no `prefill`**.

### 6.2 `lookalike_spec` fields

| Field | Meaning |
|---|---|
| `type` | `"similarity"` = top **1%**, "reach is smaller, matching is more precise". `"reach"` = top **5%**, "less precise match". Mutually exclusive with explicit `ratio`. |
| `ratio` | **0.01–0.20, in 0.01 increments.** Top x% of people in the selected country. |
| `starting_ratio` | Optional lower bound of a tier. **Must be less than `ratio`.** `starting_ratio: 0.01, ratio: 0.02` = the 1%–2% band. |
| `country` | Required (unless `location_spec`). ISO code, e.g. `"US"`. |
| `location_spec` | Alternative to `country`: `geo_locations` with `countries` or `country_groups`, plus optional exclusions. |
| `conversion_type` | `"campaign_conversions"` or `"page_like"` for non-custom-audience seeds. |
| `origin_ids` | Used with `conversion_type` seeds (campaign ID, etc.) instead of `origin_audience_id`. |
| `page_id` | For `conversion_type: "page_like"` seeds. |
| `allow_international_seeds` | Boolean. If the target country has fewer than 100 seed members, permits Meta to use seed members from other countries. |

> **Ratio semantics that trip people up.** `ratio` is a *cumulative top-x%* by default, not a
> band. `ratio: 0.05` alone means "top 5%", which **includes** the top 1%. To build genuinely
> non-overlapping tiers you must use `starting_ratio`. This matters enormously for a system
> that runs tiers as separate ad sets: without `starting_ratio`, a 1% ad set and a 5% ad set
> are bidding against each other for the same top 1% of people. That is self-inflicted
> auction overlap and it will look like "the 1% lookalike suddenly got expensive".
>
> **Docs say 0.01–0.20 (1%–20%); Ads Manager exposes 1%–10%.** The brief asked about "1%–10%
> ratio semantics" — the API range is wider than the UI range. **UNVERIFIED** whether ratios
> above 0.10 are still accepted by v26.0 or whether the doc range is stale.

### 6.3 Creating several ratio tiers at once

There is **no batch/multi-ratio parameter**. Non-overlapping tiers are N separate POSTs:

```jsonc
// tier 1: top 0–1%
{"type":"custom_ratio","starting_ratio":0.00,"ratio":0.01,"country":"US"}
// tier 2: 1–3%
{"type":"custom_ratio","starting_ratio":0.01,"ratio":0.03,"country":"US"}
// tier 3: 3–5%
{"type":"custom_ratio","starting_ratio":0.03,"ratio":0.05,"country":"US"}
```

**UNVERIFIED:** whether `type` must be `"custom_ratio"` when `starting_ratio` is used, or
whether `type` should be omitted entirely. The value-based docs use `"custom_ratio"` with an
explicit `ratio`; the tiering examples in the lookalike guide show `starting_ratio`/`ratio`
alongside `conversion_type` without a `type`. Try omitting `type` when `starting_ratio` is
present; fall back to `custom_ratio`.

Documented tiering example (campaign-conversion seed):

```bash
curl \
  -F 'subtype=LOOKALIKE' \
  -F 'lookalike_spec={
        "origin_ids": "<CAMPAIGN_ID>",
        "starting_ratio": 0.03,
        "ratio": 0.05,
        "conversion_type": "campaign_conversions",
        "country": "US"
      }' \
  -F 'access_token=<ACCESS_TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/customaudiences
```

And a Page-fan seed:

```bash
curl \
  -F 'subtype=LOOKALIKE' \
  -F 'lookalike_spec={
        "ratio": 0.01,
        "country": "US",
        "page_id": "<PAGE_ID>",
        "conversion_type": "page_like"
      }' \
  -F 'access_token=<ACCESS_TOKEN>' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/customaudiences
```

### 6.4 Value-based lookalikes

Source: https://developers.facebook.com/docs/marketing-api/audiences/guides/value-based-lookalike-audiences/

1. Create the seed custom audience with **`is_value_based=1`**.
2. Upload users with a schema that includes **`LOOKALIKE_VALUE`** alongside the identifier
   (e.g. `EMAIL`). `LOOKALIKE_VALUE` accepts "any non-negative integer or floating-point number."
3. Create the lookalike with `lookalike_spec` using **`"type": "custom_ratio"`** plus `ratio`
   and `country`.

Seed minimum is the same **100 people**.

**Relevance to this platform: low, for now.** Value-based lookalikes need per-person monetary
value, which requires CRM/purchase data this system does not have. It becomes relevant only
once a Conversions API / offline-conversion feed exists. Note it as a later unlock, not a
current capability.

---

## 7. Minimum sizes and timing

### 7.1 Seed minimum — the brief's "commonly cited 100", verified

**Confirmed, and it is a primary-source number.** The lookalike guide states the seed custom
audience must contain **at least 100 members**, and specifically **at least 100 from the
country you are targeting** — which is why `allow_international_seeds` exists.

So the commonly cited figure is right, but the commonly cited *framing* is wrong in a way that
matters: it is **100 per target country**, not 100 total. A 400-person seed spread across four
countries can fail to produce a lookalike in any of them.

For campaign-conversion lookalikes the guide states a minimum of **100 conversions**, with
**200+ recommended**.

### 7.2 Recommended seed size

Meta's guidance in the lookalike docs is the 100 floor plus "200+ recommended" for conversion
seeds. Meta has historically recommended **1,000–50,000** for a quality seed; I could not find
that range on a current primary page, so: **UNVERIFIED as a current Meta recommendation.**
Practitioner consensus lands in the same 1,000–50,000 band
(https://www.stackmatix.com/blog/meta-custom-audiences).

Engineering read: **100 is the "will it build" threshold, not the "will it be good" threshold.**
An autonomous system should gate on a *quality* floor well above 100 — otherwise it will
happily build statistically meaningless lookalikes and spend against them. Suggest 1,000 as the
build gate and treat 100–1,000 as "seed still warming".

### 7.3 Population timing

From the lookalike guide:

- **Lookalikes take 1–6 hours to fully populate.**
- **Meta refreshes lookalike members every 3 days** if the lookalike belongs to an ad set.
- Critically: *"While audiences populate, you can create and run ad sets targeting the
  audience. Once the audience is ready, Facebook delivers to people populated in the audience
  and ads delivery will catchup and work as normal."*

That last quote directly answers the brief's spend-waste concern for **lookalikes**: Meta says
it is safe to publish against a still-populating lookalike; delivery catches up. So the
scheduler does **not** need to block on lookalike population.

**It is not safe for the seed.** A video-view engagement audience with `prefill=1` needs time
to backfill, and a lookalike built from an under-populated seed is permanently worse — the
seed snapshot at build time is what gets modelled. **The gate belongs on the seed, not the
lookalike.**

**UNVERIFIED:** population time for engagement/video custom audiences themselves. Not
documented. Practitioner reports suggest ~30 minutes to a few hours for prefill.

### 7.4 Status polling — what to actually check

`operation_status` codes (source: https://developers.facebook.com/docs/marketing-api/reference/custom-audience/):

| Code | Meaning | Autonomy verdict |
|---|---|---|
| 0 | Status not available | wait |
| 100 | Expiring — unused 2+ years | warn |
| **200** | **Normal, no issues** | **proceed** |
| 400 | Warning — informational | proceed, log |
| 410 | No upload / file not uploaded | wait |
| 411 | Low match rate | warn |
| 412 | High number of invalid entries | warn |
| 414 / 415 | Replace in progress / replace failed | wait / fail |
| 421 / 422 / 423 | No pixel installed / pixel not firing / invalid pixel | fail |
| **431** | **Lookalike refresh failed** | alert |
| **432 / 433** | **Lookalike build failed** | fail — do not publish |
| **434** | **Lookalike build retrying** | wait |
| **441** | **Building audience — size will increase** | wait (this is the normal populating state) |
| 442 | Prefill unsuccessful | warn — seed may be undersized |
| 450 | Unused 30+ days, out of date | warn |
| 470 | Creator account inactive | fail |
| 471 | Flagged for integrity violations | fail |
| 500 | Error, action required | fail |

`delivery_status` codes:

| Code | Meaning |
|---|---|
| **200** | **Active and ready to be used in ads** |
| **300** | **Too small — currently inactive** |
| 400+ | Unusable due to various issues |

**The polling contract for an autonomous publisher:**

```
proceed  iff  delivery_status.code == 200
        and  operation_status.code in {200, 400}
        and  approximate_count_lower_bound >= <your quality floor>
```

`delivery_status == 300` ("too small") is the exact condition the brief is worried about, and
it is directly readable. **Never publish an ad set whose only targeting is an audience at
`delivery_status 300`** — it will under-deliver or not deliver, and in a CBO campaign the
budget silently reallocates to other ad sets, corrupting the experiment.

The practical minimum for reliable delivery is widely reported as **~1,000 people**; Meta's
own hard floor for an audience to be usable is **100**. **UNVERIFIED** as a documented number —
the 1,000 figure is practitioner consensus, not a Meta-published threshold.

`time_content_updated` is the freshness signal: if it has not moved in >3 days for a lookalike
attached to a live ad set, the every-3-days refresh is not happening and something is wrong.

---

## 8. Attaching audiences to an ad set

Source: https://developers.facebook.com/docs/marketing-api/audiences/reference/advanced-targeting

`custom_audiences` and `excluded_custom_audiences` live **inside the ad set's `targeting`
object**. Both accept an array of IDs or an array of `{id}` objects:

```jsonc
{
  "geo_locations": { "countries": ["US"] },
  "age_min": 25,
  "age_max": 40,
  "custom_audiences": [ { "id": 6004192254512 } ],
  "excluded_custom_audiences": [ { "id": 6004192252847 } ]
}
```

The bare form `"custom_audiences": [123, 456]` is also accepted. **Prefer the `{id}` object
form** — it is what Meta returns on read-back, so a read-back diff stays clean.

**Limits: up to 500 audiences in `custom_audiences` and up to 500 in
`excluded_custom_audiences`.** These are generous enough that the §3.5 200-video chunking
strategy (many audiences OR'd at targeting time) is comfortably viable.

Two consequences worth internalising:

1. Multiple entries in `custom_audiences` are **OR'd**. There is no AND across custom
   audiences at the targeting layer — if you need an intersection, build it into a single
   audience's `rule` with `"operator": "and"`.
2. Targeting a custom audience relaxes the geo requirement: *"You must specify at least one
   country in targeting, unless you use a Custom Audience"*
   (https://developers.facebook.com/docs/marketing-api/audiences/reference/basic-targeting).
   Convenient, but dangerous for autonomy — an audience-only ad set has no geo guard rail, so
   the platform should keep setting `geo_locations` explicitly regardless.

---

## 9. Sharing audiences across ad accounts

Source: https://developers.facebook.com/docs/marketing-api/business-asset-management/guides/share-custom-audiences/

### 9.1 Prerequisites

- Business Manager **admin** permission.
- A **partnership relationship established in Business Settings** between the two businesses.
- Custom Audience ToS affirmed (§1).
- **"Audiences can only be shared in one direction."**

### 9.2 The calls

Share:

```
POST /v26.0/<CUSTOM_AUDIENCE_ID>/adaccounts
  adaccounts=[<AD_ACCOUNT_ID>, ...]
  relationship_type=<one of: "Audience Info Provider" | "Information Manager"
                             | "Ad Optimizer" | "Agency">
```

`relationship_type` is **required**.

The response returns a `sharing_data` array with a per-ad-account status:
`"shared"` (approved relationship exists), `"in progress"` (pending approval),
`"not shared"` (no relationship or permission denied).

Approve/decline an incoming request:

```
POST /v26.0/<SHARING_RELATIONSHIP_ID>?request_response=approve   // or decline
```

Inspect pending requests:

```
GET /v26.0/<BUSINESS_ID>/received_audience_sharing_requests
GET /v26.0/<BUSINESS_ID>/initiated_audience_sharing_requests
  ?fields=custom_audiences,initiator,recipient,relationship_type,request_status,request_type
```

Read which accounts an audience is shared with:

```
GET /v26.0/<CUSTOM_AUDIENCE_ID>/adaccounts
GET /v26.0/<CUSTOM_AUDIENCE_ID>?fields=shared_account_info
```

### 9.3 Limits

**No maximum sharing limit is documented.** — **UNVERIFIED** whether an undocumented cap exists.

### 9.4 The cross-account rule that actually bites

From the custom audiences guide: *"We support `EXTERN_ID` parameters for individual ad
accounts. We cannot use values from one ad account for any other ad accounts, even if the
accounts belong to the same entity."* Customer-file identifiers do not port across accounts.
Engagement and video audiences are keyed on Page/video objects rather than `EXTERN_ID`, so
they are less affected — but the sharing handshake above is still required.

**For a multi-brand platform:** the asynchronous, approval-gated, admin-required, one-directional
nature of audience sharing makes it a poor fit for autonomous operation. **Prefer creating the
audience separately in each ad account** (the rule is deterministic from the video IDs) over
building a sharing-request state machine. Sharing is worth it only when the seed is expensive
to reproduce — i.e. customer files, not video views.

---

## 10. Does Advantage+ audience make lookalikes redundant?

This is the question that determines whether §§2–9 are worth building at all, so here is the
honest state rather than the comfortable one.

### 10.1 What the API says

Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/targeting-expansion/advantage-audience

- Field: **`targeting_automation.advantage_audience`**, values **`1`** (enabled) / **`0`** (disabled).
- **Default: `1` in v23.0+** when creating new ad sets with default or relaxed targeting setups.
- When enabled, **`age_min` may only be 18–25 and `age_max` is fixed at 65**. That is a
  striking constraint — it means Advantage+ audience effectively dissolves age targeting.
- The docs state *"Non-negotiable business constraints are NOT expanded"* and list
  **custom audience exclusions** among those fixed constraints.
- Opt out: set `advantage_audience` to `0`, or use a non-default, non-relaxed targeting setup
  and specify the value explicitly.

Related legacy field: `targeting_optimization` with values `expansion_all` / `none`
(https://developers.facebook.com/docs/marketing-api/audiences/reference/advantage-targeting/).
The Advantage targeting reference lists **20 optimization goals** where Meta automatically sets
expansion flags to `1` — including Value, App installs, App events, Conversations, Offsite
clicks, Landing page views, through Offer claims and Store visits.

`targeting_relaxation_types` exists and is "editable and present at the targeting spec" for
opt-in lookalike and custom-audience expansion, but **Meta does not enumerate its sub-fields
on any page I could reach**. **UNVERIFIED:** the exact sub-field names (commonly reported as
`lookalike` and `custom_audience`, each `0`/`1`) and their nesting.

### 10.2 What this means in practice — the honest read

The load-bearing asymmetry is this:

> **Inclusions are suggestions. Exclusions are constraints.**

Meta's own documentation confirms the exclusion half (custom audience exclusions are listed as
non-expanded, non-negotiable). The inclusion half is confirmed by Meta's UI language, which
distinguishes the **"original audience"** (people matching your inputs) from the **"expanded
audience"** (people the system found who do not match), and by the fact that inputs are
presented under a control literally labelled **"Audience Suggestion"**.

Current practitioner reporting is consistent and blunt: by default lookalikes are used **only
as audience suggestions**, and **for nine of the most common performance goals lookalike
inputs cannot be made restrictive at all**, regardless of the Advantage+ toggle. Meta expanded
that set of forced-suggestion goals in late 2025. Meta has also folded the old "lookalike
expansion" into a feature now branded **Advantage+ lookalike** ("previously known as lookalike
expansion").
Sources: https://www.jonloomer.com/meta-ads-targeting-2026/ ,
https://adsuploader.com/blog/meta-audience-targeting ,
https://www.bulkcreatives.com/blog/meta-advantage-plus-audience-vs-custom-audiences-2026
(secondary sources — Meta does not publish the list of nine goals; **UNVERIFIED** as to which
nine.)

### 10.3 Verdict for this platform

**Positive lookalike targeting: largely redundant. Do not build a tiered-lookalike prospecting
system as a primary strategy.** For most performance goals you cannot make it binding, so a
"1% LAL ad set" and a "broad ad set" are frequently the *same ad set* with different labels —
which also means any A/B between them is measuring noise. This is a real threat to the
autonomy loop in `src/autonomy/`: an experiment comparing audience tiers may be structurally
incapable of producing a signal, and the posterior will happily fit noise. **Any audience-tier
experiment must first verify that the tiers actually delivered to different people** (compare
reach/frequency and, if available, audience breakdowns) before its result is allowed to update
a genome.

**Exclusions: build these, they are the real win.** `excluded_custom_audiences` remains a hard
constraint by Meta's own documentation. Excluding converters, excluding people who already saw
95% of the creative, and excluding existing customers are all still fully effective, and they
are precisely what an autonomous creative-rotation system needs to avoid burning frequency on
the same people.

**Lookalike seeds: still worth building, for a different reason than the literature says.**
Even as suggestions, seeds feed Meta's model. A high-quality seed makes Advantage+ better. The
value moved from "targeting precision" to "signal quality". That reframing also lowers the
engineering bar: you need *a* good seed, not a *tiered lattice* of them.

**Video-view audiences: build them, prioritising the exclusion and seed use cases.** They are
the only first-party signal this system generates on its own, before any pixel or CRM exists.

**Concrete recommendation:** default `targeting_automation.advantage_audience = 1` and compete
on **creative** — which is this platform's actual edge — rather than on audience construction.
Spend the audience-layer engineering budget on exclusions and seed quality. Treat §§3 and 6 as
supporting infrastructure for those two jobs, not as a targeting strategy in their own right.

---

## 11. Consolidated limits table

| Limit | Value | Source confidence |
|---|---|---|
| Engagement custom audiences per ad account | **500** | Primary |
| Video IDs per video-views audience | **200** (`#2654 / 1870231`) | Live-verified, non-primary |
| Engagement sources per page-engagement audience | **5** (`#200 / 1713153`) | Live-verified, non-primary |
| Rules per audience | **10** | Primary |
| Filters per rule | **100** | Primary |
| `custom_audiences` per ad set | **500** | Primary |
| `excluded_custom_audiences` per ad set | **500** | Primary |
| Lookalike seed minimum | **100** (per target country) | Primary |
| Campaign-conversion lookalike minimum | **100** conversions, 200+ recommended | Primary |
| Lookalike `ratio` | **0.01–0.20**, 0.01 increments (UI exposes 1–10%) | Primary (range may be stale) |
| Lookalike population time | **1–6 hours** | Primary |
| Lookalike refresh cadence | **every 3 days** when attached to an ad set | Primary |
| `retention_days` (node reference) | **1–180** | Primary (conflicts below) |
| `retention_seconds` (audience-rules) | **1–365 days** | Primary (conflicts above) |
| Lead-ads engagement retention max | **90 days** | Primary |
| Page-followers (`page_liked`) retention | **must be 0** (`#2654 / 1713214`) | Live-verified, non-primary |
| Custom audience rate limit | max 700,000 requests/ad account/hour; floor of 190,000 (Standard) or 5,000 (Dev) + 40 × active custom audiences | Primary — https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/ |

---

## 12. What I would build in this repo

Suggested shape for a future `src/meta/audiences.ts` (**not created — this dossier is
research only, and audience creation is a write path that stays in SIMULATE**):

1. **`preflight` addition — ToS gate.** `GET act_<id>?fields=tos_accepted` and assert
   `custom_audience_tos === 1`. This is READ-ONLY, safe to run today, and belongs alongside
   the existing "no ad accounts / no Pages" checks. It will fail closed on a real blocker
   rather than surfacing as a confusing `#200` at publish time.
2. **Error classification.** Add `1870034`, `1870090`, `1870092` as a terminal
   `TOS_NOT_ACCEPTED` class (human intervention, never retry). Add `1870231` (too many videos)
   and `1713153` (too many page sources) as `SPLIT_REQUIRED`, and `1713214` as
   `RETENTION_MUST_BE_ZERO` — all three are deterministic and fixable without a human.
3. **Chunking by construction.** `chunkVideoIds(ids, 200)` and `chunkPageIds(ids, 5)` applied
   before payload assembly, with a deterministic `" (n of m)"` name suffix so re-runs are
   idempotent and re-chunking never double-suffixes.
4. **Read-back verification harness.** Given a hand-created UI audience ID, `GET` its `rule`,
   `subtype` and `data_source` and snapshot it as a test fixture. This is the only honest way
   to pin §3's contested shapes, and it needs zero writes.
5. **Status gate before targeting.** The predicate from §7.4, enforced in the publish path, so
   an ad set can never reference an audience at `delivery_status 300`.
6. **Do not build:** a lookalike-tier lattice, a cross-account audience-sharing state machine,
   or value-based lookalikes. §10, §9.4 and §6.4 respectively explain why each is not worth it
   at this stage.

---

## 13. Open questions — explicitly UNVERIFIED

1. **The 95% video event name.** `video_completed` vs `video_view_95_percent`. Two live-verified
   implementations disagree. Resolve by read-back (§3.6) before any audience is built.
2. **`event_name` for the 3-second and ThruPlay thresholds.** Exposed in the UI; no API name found.
3. **Whether Shape B (`event_sources` type `video`) is accepted in v26.0**, and whether it wants
   `subtype` present or absent.
4. **Whether a system user can create custom audiences on business-level ToS acceptance alone**,
   or whether a human in the owning business must have accepted first. This is the single most
   consequential unknown for autonomy — it determines whether audience creation is ever fully
   unattended.
5. **The true `retention_days` ceiling** — 180, 365 or 730. Three Meta pages give three answers.
6. **Whether lookalike `ratio` above 0.10 is still accepted**, given the UI caps at 10%.
7. **`targeting_relaxation_types` sub-field names and nesting.** Not enumerated on any reachable
   Meta page.
8. **Which nine performance goals force lookalike-as-suggestion.** Not published by Meta.
9. **Whether `type: "custom_ratio"` is required when `starting_ratio` is set.**
10. **Whether `audience_labels` (2026-04-30) applies to engagement/video audiences** or only to
    customer-file / website / mobile-app audiences.
11. **Population time for engagement and video custom audiences** (as opposed to lookalikes).
12. **Any undocumented cap on audience sharing breadth.**

---

## 14. Source index

Primary (Meta):
- Engagement custom audiences — https://developers.facebook.com/docs/marketing-api/audiences/guides/engagement-custom-audiences/
- Audience rules — https://developers.facebook.com/docs/marketing-api/audiences/guides/audience-rules/
- Lookalike audiences — https://developers.facebook.com/docs/marketing-api/audiences/guides/lookalike-audiences/
- Value-based lookalikes — https://developers.facebook.com/docs/marketing-api/audiences/guides/value-based-lookalike-audiences/
- Custom Audience node reference — https://developers.facebook.com/docs/marketing-api/reference/custom-audience/
- Custom Audience node reference (new path) — https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/custom-audience
- Custom Audience ToS — https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/custom-audience-terms-of-service
- Custom Audience data sources — https://developers.facebook.com/docs/marketing-api/reference/custom-audience-data-source/
- Customer file custom audiences — https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/custom-audiences
- Advanced targeting — https://developers.facebook.com/docs/marketing-api/audiences/reference/advanced-targeting
- Basic targeting — https://developers.facebook.com/docs/marketing-api/audiences/reference/basic-targeting
- Advantage+ audience — https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/targeting-expansion/advantage-audience
- Advantage targeting — https://developers.facebook.com/docs/marketing-api/audiences/reference/advantage-targeting/
- Share custom audiences between businesses — https://developers.facebook.com/docs/marketing-api/business-asset-management/guides/share-custom-audiences/
- Error reference — https://developers.facebook.com/docs/marketing-api/error-reference/
- Rate limiting — https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/
- 2026 out-of-cycle changes — https://developers.facebook.com/documentation/ads-commerce/marketing-api/out-of-cycle-changes/occ-2026
- Video plays at 95% (metric definition) — https://www.facebook.com/business/help/259313030934362

Live-verified third-party code (non-primary, cited where used):
- https://github.com/matas-offpixel/meta-campaign-builder — `lib/meta/audience-payload.ts` (read-back verification of UI-created audiences, 2026-05 dated)
- https://github.com/Cjota221/vexxcrm — `src/lib/services/meta-publicos-cj.service.ts`

Secondary commentary (2026 Advantage+ state, cited where used):
- https://www.jonloomer.com/meta-ads-targeting-2026/
- https://adsuploader.com/blog/meta-audience-targeting
- https://www.bulkcreatives.com/blog/meta-advantage-plus-audience-vs-custom-audiences-2026
- https://www.stackmatix.com/blog/meta-custom-audiences
- https://help.trafficguard.ai/en/articles/11086204-how-to-accept-facebook-s-custom-audience-terms-of-service
