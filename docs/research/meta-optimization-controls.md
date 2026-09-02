# Meta programmatic optimization controls & experiments

**Compiled 2026-09-02. Marketing API / Graph API v26.0 (released 2026-07-29).**
Companion to `meta-api-foundations.md` (auth, versions, rate limits), `meta-campaign-publishing.md` (campaign/adset/ad creation), `meta-insights-measurement.md` (Insights API, attribution, `learning_stage_info` read surface), `meta-video-creative.md` (creative specs, `degrees_of_freedom_spec`).

This document covers **the levers a program can pull after the ads are live**, and what each lever costs you.

Every non-obvious claim carries a source URL. Claims sourced from `facebook.com/business/help/*` were retrieved through a text-extraction proxy (`r.jina.ai`) because those pages are JS-rendered and return an error shell to plain HTTP clients — the canonical URL is what is cited. Anything I could not confirm is marked **UNVERIFIED**.

---

## 0. Executive summary — the decision this document exists to settle

| Question | Answer |
|---|---|
| Should the platform use Meta's native Automated Rules (`adrules_library`) as its control loop? | **No, not as the primary loop.** Use it for a small set of *guardrails* that must fire when your infrastructure is down, and for the one thing you cannot replicate (`TRIGGER` rules with p99 ~7.5 min latency on insights changes, and `PING_ENDPOINT` webhooks). |
| Why not? | Rules are single-`time_preset`, AND-only, no cross-object logic, no statistical tests, no memory of prior actions beyond `action_frequency`, cannot read `learning_stage_info`, cannot create/rotate creative, and cap at 250 per account. |
| What is the biggest constraint on an autonomous optimizer? | **Not the API. The learning phase.** ~50 optimization events per ad set per 7 days, and any "significant edit" restarts the clock. An aggressive loop that edits daily will keep every ad set permanently in learning. |
| What is the single most under-used official lever? | **`GET/POST /act_{id}/recommendations`** (Opportunity Score & Recommendations). **37** documented recommendation types, 14 of them applyable via a single POST with a `recommendation_signature`. This is Meta telling you exactly what it wants you to change. |
| Is split testing still alive via API on 2026-09-02? | **Yes.** `POST /{business_id}/ad_studies` with `type=SPLIT_TEST` (or `SPLIT_TEST_V2` for creative tests) is documented at v26.0 with no deprecation notice. But it is a blunt instrument — see §7.6. |

---

## 1. The Automated Rules API (`adrules_library`)

### 1.1 Object model and endpoints

Ad rules are **standalone Graph objects owned by an ad account**, not properties of campaigns. They are stored in the account's "rules library" and evaluated by Meta's own infrastructure.

```
POST   /v26.0/act_{AD_ACCOUNT_ID}/adrules_library      # create
GET    /v26.0/act_{AD_ACCOUNT_ID}/adrules_library      # list
GET    /v26.0/{AD_RULE_ID}                             # read
POST   /v26.0/{AD_RULE_ID}                             # update (all params optional)
DELETE /v26.0/{AD_RULE_ID}                             # delete -> {"success": true}
GET    /v26.0/{AD_RULE_ID}/history                     # per-rule execution history
GET    /v26.0/act_{AD_ACCOUNT_ID}/adrules_history      # account-wide execution history
GET    /v26.0/{CAMPAIGN_ID}/adrules_governed           # which rules govern this object
GET    /v26.0/{ADSET_ID}/adrules_governed
GET    /v26.0/{AD_ID}/adrules_governed
```

Sources:
- https://developers.facebook.com/docs/marketing-api/reference/ad-rule/
- https://developers.facebook.com/docs/marketing-api/reference/ad-account/adrules_library/
- https://developers.facebook.com/docs/marketing-api/reference/ad-rule/history/
- https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/adrules_governed

`AdRule` read fields (verbatim from the v26.0 reference): `id`, `account_id`, `created_by` (User), `created_time`, `disable_error_code` (int32 — *"Error explanation for disabled rules"*), `name` (*"The friendly name of a rule, optional for inline rules"*), `schedule_spec`, `status`, `updated_time`. Edge: `history` — *"The execution history associated with this rule. Each entry represents a distinct run of the rule."*

`status` enum on create/update: **`ENABLED`, `DISABLED`, `DELETED`, `HAS_ISSUES`**.
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-account/adrules_library/

> **Gotcha — `disable_error_code`.** Meta will silently disable a rule (`status` flips, `disable_error_code` populates) if it repeatedly errors. An autonomous system must poll `GET /act_{id}/adrules_library?fields=id,name,status,disable_error_code` on a schedule, not assume its rules are still running.

### 1.2 `evaluation_spec` — which objects the rule acts on

```json
"evaluation_spec": {
  "evaluation_type": "SCHEDULE",          // SCHEDULE | TRIGGER   [required]
  "filters": [                            // [required]
    {"field": "entity_type", "value": "ADSET", "operator": "EQUAL"},
    {"field": "time_preset", "value": "LAST_3_DAYS", "operator": "EQUAL"},
    {"field": "spent", "value": 5000, "operator": "GREATER_THAN"},
    {"field": "cost_per_offsite_conversion.fb_pixel_purchase",
     "value": 4000, "operator": "GREATER_THAN"}
  ],
  "trigger": { ... }                      // TRIGGER rules only
}
```

**`operator` enum (complete, verbatim):** `GREATER_THAN`, `LESS_THAN`, `EQUAL`, `NOT_EQUAL`, `IN_RANGE`, `NOT_IN_RANGE`, `IN`, `NOT_IN`, `CONTAIN`, `NOT_CONTAIN`, `ANY`, `ALL`, `NONE`.
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-account/adrules_library/

**Filter combination semantics — verbatim:** *"All filters are evaluated together using the `AND` operator."*
There is **no OR**. If you need `(cpa > X) OR (frequency > Y)` you must create two rules. With a 250-rule-per-account ceiling (§1.8) this is the first thing that pushes a real optimizer out of native rules.
Source: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/evaluation-spec/

**Implicit filters you did not write — corrected verbatim (fact-checked 2026-09-02):** *"By default, if you do not specify an `effective_status` filter, we implicitly add an `effective_status` filter when evaluating the rule."*
The default is **not** uniform across execution types. The page documents two cases:
- For execution types that act on **active** objects: operator `IN` with `['ACTIVE', 'PENDING_REVIEW']` — *"the rule only evaluates objects that have or will have active delivery."*
- For execution types that do **not** act on active objects, **`UNPAUSE` explicitly named**: operator `NOT_IN` with `['DELETED', 'ARCHIVED']`, described as *"an internal optimization for our execution types."*

~~Consequence: an `UNPAUSE` rule that only filters on metrics will never see a paused object unless you explicitly override `effective_status`. This is the classic "my unpause rule does nothing" bug.~~
**This was wrong.** Meta already special-cases `UNPAUSE`: a metrics-only `UNPAUSE` rule *does* see paused objects, because its implicit filter is `NOT_IN ['DELETED','ARCHIVED']`, not `IN ['ACTIVE','PENDING_REVIEW']`. The real trap is the inverse and it is still worth guarding: an `UNPAUSE` rule will happily reactivate an object **your own loop deliberately paused**, since `PAUSED` is neither `DELETED` nor `ARCHIVED`. If you pause for a business reason, either archive instead, or scope `UNPAUSE` rules by `id`/`adlabel_ids`, or set an explicit `effective_status` filter.
Source: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/evaluation-spec/

**Static vs dynamic scope — verbatim:** filtering on `entity_type` means the rule *"automatically evaluates every new ad that added to the ad account. This happens regardless of when you create the rule."* Filtering on `id` (`{"field":"id","value":[123,456],"operator":"IN"}`) pins the rule to a static list.
This is the single most dangerous property of native rules for an automated publisher: **a rule you created in January will start acting on ad sets your pipeline creates in September**, including ones deliberately in a protected learning window.

**`time_preset` — exactly one per rule, verbatim:** *"Currently, we only allow one `time_preset`. It applies to all stats filters in the rule, including the one used for the trigger, if present."*
Operator must be `EQUAL`. Accepted values (verbatim list): `LIFETIME, TODAY, LAST_2_DAYS, LAST_3_DAYS, LAST_7_DAYS, LAST_14_DAYS, LAST_28_DAYS, LAST_30_DAYS, THIS_MONTH, THIS_WEEK_MON_TODAY, THIS_WEEK_SUN_TODAY, YESTERDAY, LAST_2D, LAST_3D, LAST_7D, LAST_14D, LAST_28D, LAST_30D, LAST_ND_14_8, LAST_ND_30_8, LAST_ND_60_8, LAST_ND_120_8, LAST_ND_180_8, LAST_ND_LIFETIME_8, LAST_ND_60_29, LAST_ND_120_29, LAST_ND_180_29, LAST_ND_LIFETIME_29`.
Note the docs state many presets **include today's partial data** because *"today's data is critical for rules that run more than once a day."* That is precisely why a naive `LAST_3_DAYS` CPA pause rule kills good ads at 09:00 — today's spend is booked before today's conversions land.
Source: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/evaluation-spec/

**`attribution_window`** — schedule-based rules only, operator must be `EQUAL`, and the only documented value is `ACCOUNT_DEFAULT`. There is no way to make a rule evaluate on a 1-day-click window when the account default is 7-day-click.

**Metadata filter fields (both rule types):** `id`, `entity_type`, `name`, `adlabel_ids`, `objective`, `start_time`, `stop_time`, `buying_type`, `billing_event`, `optimization_goal`, `is_autobid`, `daily_budget`, `lifetime_budget`, `spend_cap`, `bid_amount`, `created_time`, `updated_time`.

**Metadata fields available to SCHEDULE rules only:** `effective_status`, `placement.page_types`, `budget_reset_period`, `hours_since_creation`, `estimated_budget_spending_percentage`, `audience_reached_percentage`, `active_time`, `current_time`.
`hours_since_creation` and `active_time` are the two fields that let you write "don't touch anything younger than N hours" into the rule itself. Use them.

**`entity_type` enum:** `AD`, `ADSET`, `CAMPAIGN`.

**Cross-level filtering** is supported with a dotted prefix — verbatim example:
```json
"filters": [
  {"field": "entity_type", "value": "ADSET", "operator": "EQUAL"},
  {"field": "campaign.objective", "value": "WEBSITE_CLICKS", "operator": "EQUAL"}
]
```

**Insights filter fields** (trigger-compatible subset, verbatim): `impressions, unique_impressions, clicks, unique_clicks, spent, results, cost_per, cpc, cpm, ctr, cpa, cpp, reach, frequency, leadgen, link_ctr, cost_per_unique_click, result_rate, mobile_app_install, cost_per_mobile_app_install, app_custom_event (all variants), cost_per_mobile_* (all variants), offsite_conversion (all variants), cost_per_* (offsite variants), link_click, cost_per_link_click, like, offsite_engagement, post, post_comment, post_engagement, post_like, post_reaction, view_content, video_play, vote`.

**Advanced filters** exist (derived metrics such as `daily_ratio_spent`), support **only numeric comparison operators**, and are **schedule-rules-only**. The 2018 feature announcement adds *prefixed insights fields* ("multi-level filtering and overriding the rule's time prefix"), *aggregation* ("compute Insights across multiple ad objects collectively") and *formulas* ("arithmetic expressions that include constants, Insights, and numeric Metadata filters"). The dedicated advanced-filters doc page 404s at v26.0.
Sources: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/evaluation-spec/ and https://developers.facebook.com/ads/blog/post/v2/2018/04/25/new-features-ad-rules-engine/
**UNVERIFIED:** the exact syntax for aggregation and formula filters. The announcement describes them; no live reference page could be retrieved.

### 1.3 `evaluation_type: TRIGGER` — the one thing you cannot build yourself

Trigger rules are **API-only** — verbatim: *"not accessible through Ads Manager."*

```json
"evaluation_spec": {
  "evaluation_type": "TRIGGER",
  "filters": [ ... ],
  "trigger": {
    "type": "STATS_CHANGE",              // [required]
    "field": "cost_per_link_click",
    "value": 300,
    "operator": "GREATER_THAN"
  }
}
```

**`trigger.type` enum (complete, from the v26.0 create reference):** `METADATA_CREATION`, `METADATA_UPDATE`, `STATS_MILESTONE`, `STATS_CHANGE`, `DELIVERY_INSIGHTS_CHANGE`.
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-account/adrules_library/

Semantics (verbatim from the guide):
- `METADATA_CREATION` — fires when an ad object is created. `field` is omitted for this type.
- `METADATA_UPDATE` — fires when a metadata field is modified. `value`/`operator` optional.
- `STATS_CHANGE` — *"Activates when insights shift from failing to satisfying conditions"* (edge-triggered, not level-triggered — it will not re-fire while the condition stays true).
- `STATS_MILESTONE` — fires when insights reach **multiples** of a specified value (e.g. every 1000 impressions).
- `DELIVERY_INSIGHTS_CHANGE` — appears in the v26.0 enum; **UNVERIFIED**, no guide text found. Plausibly the hook for "Creative limited / Creative fatigue / Learning limited" delivery-status transitions, which would make it the most valuable trigger on the list. Worth probing on a live account.

**Latency — verbatim:** metadata changes *"usually a few seconds"*; insights changes *"usually within a few minutes (current p99 is about 7.5 minutes)"*.
Source: https://developers.facebook.com/docs/marketing-api/ad-rules/guides/trigger-based-rules/

**Constraints:** `schedule_spec` is **not supported** for trigger rules — full verbatim: *"For Trigger Based Rules, `schedule_spec` is not supported, since they are always checked in real time."* Exactly one trigger per rule; everything else goes in `filters`. `CHANGE_BUDGET`, `CHANGE_CAMPAIGN_BUDGET`, `CHANGE_BID`, `ROTATE` and `REBALANCE_BUDGET` are **schedule-only** execution types.

> **Corrected 2026-09-02.** An earlier draft said a trigger rule can be `PAUSE`, `UNPAUSE`, `NOTIFICATION` or `PING_ENDPOINT`. The trigger-based-rules guide contains **no list or table of supported execution types** and demonstrates exactly three — `PING_ENDPOINT`, `NOTIFICATION`, `PAUSE`. **`UNPAUSE` does not appear anywhere on that page.** Treat trigger-rule `UNPAUSE` as **UNVERIFIED**; probe it on a live account before designing an auto-reactivation path around it.
Source: https://developers.facebook.com/docs/marketing-api/ad-rules/guides/trigger-based-rules/

### 1.4 `PING_ENDPOINT` — Meta's push channel into your control loop

This is the highest-value piece of the whole rules engine for a system that has its own brain: let Meta watch the metrics in near-real-time and **push** to you, instead of polling Insights (which burns your `ads_insights` BUC quota — see `meta-api-foundations.md` §8).

Webhook payload (verbatim from the docs):
```json
{
  "object": "application",
  "entry": [{
    "id": "<APPLICATION_ID>",
    "time": 1468938744,
    "changes": [{
      "field": "ads_rules_engine",
      "value": {
        "rule_id": 1234,
        "object_id": 5678,
        "object_type": "ADSET",
        "trigger_type": "STATS_CHANGE",
        "trigger_field": "COST_PER_LINK_CLICK",
        "current_value": "15.8"
      }
    }]
  }]
}
```

Subscription (verbatim, requires an **app access token**, not a user token):
```bash
curl -F "object=application" \
  -F "callback_url=<CALLBACK_URL>" \
  -F "fields=ads_rules_engine" \
  -F "verify_token=<VERIFY_TOKEN>" \
  -F "access_token=<APP_ACCESS_TOKEN>" \
  "https://graph.facebook.com/v26.0/<APP_ID>/subscriptions"
```
Source: https://developers.facebook.com/docs/marketing-api/ad-rules/guides/trigger-based-rules/

> **Gotcha.** The subscription object is `application`, and the webhook is delivered **once per app**, not per ad account. The payload contains no ad account id — you must resolve `object_id` → account yourself. For a multi-tenant platform, maintain an `object_id → tenant` index or you will not know whose ad set just spiked.

### 1.5 `execution_spec` — what the rule does

```json
"execution_spec": {
  "execution_type": "CHANGE_BUDGET",     // [required]
  "is_once_off": false,
  "execution_options": [
    {"field": "change_spec",
     "value": {"amount": 20, "unit": "PERCENTAGE", "limit": 50000},
     "operator": "EQUAL"},
    {"field": "action_frequency", "value": 1440, "operator": "EQUAL"},
    {"field": "execution_count_limit", "value": 5, "operator": "EQUAL"},
    {"field": "user_ids", "value": [123, 456], "operator": "EQUAL"}
  ]
}
```

**Complete `execution_type` enum, verbatim from the v26.0 create reference** (note this is materially longer than the guide's list of 9):

```
DCO, PING_ENDPOINT, NOTIFICATION, PAUSE, REBALANCE_BUDGET, CHANGE_BUDGET,
CHANGE_BID, ROTATE, UNPAUSE, CHANGE_CAMPAIGN_BUDGET, ADD_INTEREST_RELAXATION,
ADD_QUESTIONNAIRE_INTERESTS, INCREASE_RADIUS, UPDATE_CREATIVE,
UPDATE_LAX_BUDGET, UPDATE_LAX_DURATION, AUDIENCE_CONSOLIDATION,
AUDIENCE_CONSOLIDATION_ASK_FIRST, AD_RECOMMENDATION_APPLY
```
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-account/adrules_library/

Documented behaviour of the nine in the guide (verbatim descriptions):

| `execution_type` | What it does | SCHEDULE | TRIGGER |
|---|---|---|---|
| `NOTIFICATION` | *"Sends a jeweled notification to this rule's creator, or the list of users specified in `user_ids`"* | ✅ | ✅ |
| `PAUSE` | Halts the matched objects | ✅ | ✅ |
| `UNPAUSE` | Reactivates matched objects | ✅ | ✅ |
| `CHANGE_BUDGET` | *"Changes the budgets based on a defined `change_spec`"* — **ad sets only** | ✅ | ❌ |
| `CHANGE_CAMPAIGN_BUDGET` | Same, at campaign level | ✅ | ❌ |
| `CHANGE_BID` | Adjusts `bid_amount` via `change_spec` — ad sets | ✅ | ❌ |
| `ROTATE` | *"Pauses the currently active ad, and activates the next ad by ID in the ad set"* | ✅ | ❌ |
| `REBALANCE_BUDGET` | *"Pauses the objects that match the evaluation criteria, and rebalances their budgets"* | ✅ | ❌ |
| `PING_ENDPOINT` | Webhook | ❌ | ✅ |

Source: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/execution-spec/

**The ten undocumented ones matter.** `UPDATE_CREATIVE`, `DCO`, `AD_RECOMMENDATION_APPLY`, `AUDIENCE_CONSOLIDATION`, `ADD_INTEREST_RELAXATION`, `INCREASE_RADIUS`, `UPDATE_LAX_BUDGET`, `UPDATE_LAX_DURATION` are in the live v26.0 enum with no guide text. They are almost certainly the API surface behind Ads Manager's auto-apply-recommendations feature — corroborated by the `AdRuleHistory.action` enum (§1.7), which contains `ENABLE_ADVANTAGE_PLUS_CREATIVE`, `ENABLE_ADVANTAGE_CAMPAIGN_BUDGET`, `CONSOLIDATE_FRAGMENTATION`, `ENABLE_GEN_UNCROP`, etc. **UNVERIFIED:** their required `execution_options` shapes. Do not build on them without live probing; use `POST /act_{id}/recommendations` (§10) instead, which is documented.

### 1.6 `execution_options` — the four that keep a rule from destroying an account

| `field` | Applies to | Type | Verbatim semantics |
|---|---|---|---|
| `change_spec` | `CHANGE_BUDGET`, `CHANGE_CAMPAIGN_BUDGET`, `CHANGE_BID` | dict | see below |
| `rebalance_spec` | `REBALANCE_BUDGET` | dict | *"Supports different options that determine how budgets are rebalanced."* |
| `execution_count_limit` | `CHANGE_BUDGET`, `CHANGE_BID` | int | *"Specifies the maximum number of times a budget/bid change action is taken for each individual ad object for the rule."* |
| `action_frequency` | `CHANGE_BUDGET`, `CHANGE_BID` | int (**minutes**) | *"Specifies the minimum amount of minutes until the same action can be taken on an object by a rule."* Docs example: `10080` = one week. |
| `user_ids` | all schedule types | array | *"Jeweled notification recipients for `NOTIFICATION`, or recipients for Schedule Based Rules summary emails."* Summary email is generated *"at 12:30AM, using the ad account's time zone."* |

Verbatim constraint: *"Currently, the only supported operator for all options is `EQUAL`."* (The `AdRuleExecutionOptions` node reference lists `EQUAL, IN` — treat `EQUAL` as the safe choice.)
Sources: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/execution-spec/ , https://developers.facebook.com/docs/marketing-api/reference/ad-rule-execution-options/

**`change_spec` fields (verbatim):**

| Field | Required | Meaning |
|---|---|---|
| `amount` | ✅ | *"Determines the amount to change the budget or bid"* — e.g. `3000`, `-50` |
| `unit` | ✅ unless `target_field` present | **`ACCOUNT_CURRENCY`** or **`PERCENTAGE`**. (Note: `ABSOLUTE` is *not* a valid unit here — that enum belongs to `budget_schedules.budget_value_type`. Confusing these is a real bug.) |
| `limit` | optional | *"Specifies the maximum or minimum budget or bid amount"*; a scalar for plain changes, a **range array** `[min, max]` when `target_field` is used |
| `target_field` | optional | *"Scales budgets or bids by a target value"* — `amount` becomes the target; system adjusts proportionally against current performance. Examples given: `cost_per_mobile_app_install`, `mobile_app_purchase_roas` |

Source: https://developers.facebook.com/docs/marketing-api/ad-rules-examples/change-spec

Two verbatim working examples from that page (API version placeholder is Meta's):

```bash
# Cut ad set budgets 30% on Tuesdays and Fridays at midnight when frequency > 5 and impressions > 8000
curl -F 'name=Test Change Budget Rule' \
 -F 'schedule_spec={"schedule_type": "CUSTOM", "schedule": [{"start_minute": 0, "days": [2, 5]}]}' \
 -F 'evaluation_spec={"evaluation_type": "SCHEDULE", "filters": [
       {"field": "entity_type", "value": "ADSET", "operator": "EQUAL"},
       {"field": "time_preset", "value": "LIFETIME", "operator": "EQUAL"},
       {"field": "impressions", "value": 8000, "operator": "GREATER_THAN"},
       {"field": "frequency", "value": 5.0, "operator": "GREATER_THAN"}]}' \
 -F 'execution_spec={"execution_type": "CHANGE_BUDGET", "execution_options": [
       {"field": "change_spec", "value": {"amount": -30, "unit": "PERCENTAGE"}, "operator": "EQUAL"}]}' \
 -F "access_token=<ACCESS_TOKEN>" \
 https://graph.facebook.com/<VERSION>/<AD_ACCOUNT_ID>/adrules_library

# Bid targeting: drive CPI toward 5.0, clamped to [2.0, 10.0]
curl -F 'name=Test Change Bid Rule' \
 -F 'schedule_spec={"schedule_type": "DAILY"}' \
 -F 'evaluation_spec={"evaluation_type": "SCHEDULE", "filters": [
       {"field": "id", "value": [123], "operator": "IN"},
       {"field": "time_preset", "value": "LIFETIME", "operator": "EQUAL"},
       {"field": "mobile_app_install", "value": 100, "operator": "GREATER_THAN"},
       {"field": "cost_per_mobile_app_install", "value": [4.5, 5.5], "operator": "NOT_IN_RANGE"}]}' \
 -F 'execution_spec={"execution_type": "CHANGE_BID", "execution_options": [
       {"field": "change_spec", "value": {"amount": 5.0, "limit": [2.0, 10.0],
        "target_field": "cost_per_mobile_app_install"}, "operator": "EQUAL"}]}' \
 -F "access_token=<ACCESS_TOKEN>" \
 https://graph.facebook.com/<VERSION>/<AD_ACCOUNT_ID>/adrules_library
```

**`rebalance_spec` / `REBALANCE_BUDGET`.** The 2018 announcement documents "Rebalance Budget v2" with two additional rebalance types: **`NO_PAUSE_PROPORTIONAL`** — *"for moving budget without pausing matched objects"* — and **`MATCHED_ONLY_PROPORTIONAL`** — *"for shifting budget among matched objects only"*. The base behaviour (pause matched objects and redistribute their budget proportionally to the survivors) is the implicit `PROPORTIONAL`.
Source: https://developers.facebook.com/ads/blog/post/v2/2018/04/25/new-features-ad-rules-engine/
**UNVERIFIED:** the exact key name (`rebalance_type` vs other) and whether `PROPORTIONAL` is a literal enum value. The dedicated `ad-rules-examples/rebalance-spec` page 404s at v26.0.

### 1.7 `schedule_spec` and history

```json
"schedule_spec": {
  "schedule_type": "CUSTOM",             // DAILY | HOURLY | SEMI_HOURLY | CUSTOM
  "schedule": [
    {"days": [1,2,3,4,5]},                        // weekdays, all day
    {"start_minute": 720, "end_minute": 780, "days": [0,6]}   // weekends 12:00–13:00
  ]
}
```

Verbatim semantics:
- `DAILY` — *"Run the rule at midnight in the ad account's timezone."*
- `HOURLY` — *"Run the rule at the start of every hour."*
- `SEMI_HOURLY` — *"Run the rule at the start of every half-hour."* **This is the maximum evaluation frequency.**
- `CUSTOM` — `start_minute` / `end_minute` are *"Time in minutes after 12:00AM. Must be a multiple of 30 minutes"*; `end_minute` must be after `start_minute`; `days` values 0–6 where *"0 is Sunday, 1 is Monday, ..., 6 is Saturday"*; *"At least one of start_minute or days must exist in each entry."*

Sources: https://developers.facebook.com/docs/marketing-api/ad-rules/guides/advanced-scheduling and https://developers.facebook.com/docs/marketing-api/ad-rules/guides/scheduled-based-rules/

**`AdRuleHistory`** node fields: `timestamp`, `results`, `exception_code`, `exception_message`, `evaluation_spec`, `execution_spec`, `is_manual`, `rule_id`, `schedule_spec`.
Read params on both `/{rule_id}/history` and `/act_{id}/adrules_history`: `action`, `hide_no_changes` (*"exclude entries with no results or only NOT_CHANGED actions"*), `object_id`.

**`action` enum (complete, verbatim — read this list carefully, it leaks Meta's roadmap):**
```
BUDGET_NOT_REDISTRIBUTED, CHANGED_BID, CHANGED_BUDGET, EMAIL, ENDPOINT_PINGED, ERROR,
FACEBOOK_NOTIFICATION_SENT, MESSAGE_SENT, NOT_CHANGED, PAUSED, UNPAUSED,
ENABLE_AUTOFLOW, ENABLE_ADVANTAGE_PLUS_CREATIVE, ENABLE_SEMANTIC_BASED_AUDIENCE_EXPANSION,
ENABLE_ADVANTAGE_PLUS_PLACEMENTS, ENABLE_ADVANTAGE_CAMPAIGN_BUDGET, ENABLE_GEN_UNCROP,
ENABLE_MUSIC, ENABLE_SHOPS_ADS, CONVERT_ASC_CP_SINGLE_INSTANCE, CONSOLIDATE_ASC_FRAGMENTATION,
CONSOLIDATE_FRAGMENTATION, ENABLE_REELS_PLACEMENTS, ENABLE_LANDING_PAGE_VIEWS,
ENABLE_ADVANTAGE_PLUS_AUDIENCE, ENABLE_PRODUCT_SET_BOOSTING, ENABLE_SHOPS_ADS_SAOFF,
ENABLE_PIXELLESS_LPV_OPTIMIZATION_GOAL, ENABLE_WTWA_UPSELL_IN_DUPLICATION
```
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-rule/history/

`BUDGET_NOT_REDISTRIBUTED` is the failure mode of `REBALANCE_BUDGET` — poll for it.

**Preview / execute endpoints.** Meta's 2017 and 2018 announcements describe *"Preview and Execute Endpoints"* that *"allow preview objects that pass the evaluation phase and manual execution of Schedule-Based Rules."* Both `/{ad_rule_id}/preview` and `/{ad_rule_id}/execute` reference pages return 404 at v26.0.
**UNVERIFIED:** exact paths and parameters. The `is_manual` field on `AdRuleHistory` confirms manual execution exists. Probe `POST /{rule_id}/execute` on a live account before designing a dry-run flow around it.
Sources: https://developers.facebook.com/ads/blog/post/2017/11/08/ad-rules-engine-blog-post/ , https://developers.facebook.com/ads/blog/post/v2/2018/04/25/new-features-ad-rules-engine/

### 1.8 Limits and hard restrictions

From Meta's Business Help Center, "Limits to Automated Rules" (these apply to the same underlying engine that `adrules_library` writes to):

- *"You can create up to **250 automated rules** on a single ad account."*
- *"You can only add **one of each condition per rule**."*
- *"You can only associate a **single rule with objects on the same level**."* — you cannot mix campaigns and ad sets in one rule.
- *"Automated rules can't run on ads about social issues, elections or politics."*
- *"Automated rules can't pause reservation campaigns."*

Source: https://www.facebook.com/business/help/222640851458826

Rules apply **at the ad account level** — verbatim: *"Automated rules apply at the Ad account level, so they work when anyone in your team makes ads."*
Source: https://www.facebook.com/business/help/1694779440789213

Error codes on create/update (verbatim from the v26.0 reference):

| Code | Message |
|---|---|
| 100 | Invalid parameter |
| 190 | Invalid OAuth 2.0 Access Token |
| 200 | Permissions error |
| 368 | *"The action attempted has been deemed abusive or is otherwise disallowed"* |
| **80004** | *"There have been too many calls to this ad-account. Wait a bit and try again."* — **rule writes are themselves rate-limited per ad account.** A bulk rule-provisioning job across many accounts must back off on this. (Added by fact-check; missing from the earlier draft.) |
| **2703** | ***"Rules that turn off ads can't have cost conditions. You need to change the rule's conditions or action."*** (full message; the earlier draft quoted only the first sentence) |

> **Gotcha — error 2703 is a policy, not a bug.** Meta will not let you create a native rule that pauses an object based on a cost metric (CPA / CPC / cost_per_*). This kills the single most obvious rule anyone wants ("pause any ad with CPA > $40"). Confirmed in the reference: https://developers.facebook.com/docs/marketing-api/reference/ad-rule/ and https://developers.facebook.com/docs/marketing-api/reference/ad-account/adrules_library/
> **This one restriction is, on its own, sufficient reason to run your own control loop.** Your own loop calls `POST /{ad_id}` with `status=PAUSED` and Meta does not care what logic produced it.

### 1.9 Native rules vs. your own control loop

| | Native `adrules_library` | External loop (poll Insights → decide → POST) |
|---|---|---|
| Runs when your infra is down | ✅ | ❌ |
| Costs API quota | ~0 | Insights BUC quota + `ads_management` quota (see foundations §8) |
| Latency on stats | SCHEDULE: 30 min floor. TRIGGER: p99 ~7.5 min | Your poll interval; Insights data itself is ≥ minutes stale |
| Boolean logic | **AND only** | anything |
| Multiple time windows in one decision | **No** (one `time_preset`) | yes |
| Cost-based pausing | **Blocked (error 2703)** | ✅ |
| Can read `learning_stage_info` | ❌ | ✅ |
| Can read `issues_info`, `recommendations`, `opportunity_score` | ❌ | ✅ |
| Statistical tests (Bayesian / sequential) | ❌ | ✅ |
| Can create/replace creative | Only via undocumented `UPDATE_CREATIVE`/`DCO` | ✅ |
| Cross-account / portfolio logic | ❌ | ✅ |
| Audit trail | `/adrules_history`, `action` enum | yours |
| Scale ceiling | 250 rules/account, 1 level/rule | none |
| Silent self-disable | ✅ (`disable_error_code`) | n/a |

**Recommended architecture: hybrid, with native rules used only as a dead-man's switch.**

1. **Native, per account, ~5 rules max:**
   - `PAUSE` on `spent > hard_daily_cap` (spend is not a "cost condition", so 2703 does not apply) — protects against a runaway loop or a runaway budget rule.
   - `PAUSE` on `frequency > N` with `time_preset=LAST_7_DAYS` and `hours_since_creation > 168`.
   - `NOTIFICATION` rules mirroring the above, addressed to the operator's user id.
   - One `TRIGGER` + `PING_ENDPOINT` rule per account on `STATS_MILESTONE` (e.g. every 1000 impressions) to wake your loop cheaply instead of polling.
2. **Everything intelligent in your own loop**, with the guardrails of §6 (learning-phase awareness) and §4 (budget change discipline).
3. **Reconcile.** On every sync, `GET /act_{id}/adrules_history?hide_no_changes=true&since=...` and treat any `PAUSED`/`CHANGED_BUDGET` action you did not initiate as an external mutation. Otherwise your optimizer and Meta's rules will fight, and your state model will drift.

---

## 2. Budget mechanics you must model correctly

### 2.1 Daily budget is not a daily cap

Verbatim from Meta's "About daily budgets":
- *"On days when better advertising opportunities are available, Meta may spend up to **75% over your daily budget**."*
- *"For every week ending Saturday at midnight, spending won't be more than **7 times your daily budget**."*
- With ad set budget sharing on: *"Meta may additionally share up to 20% of your flexible daily budget with other ad sets (which means **up to 210% of your daily budget**)."*
- On a mid-day change, the system *"calculates a new spending target for the rest of the day and a new spending limit for the rest of the week,"* with the daily cap remaining at **175% of the highest budget amount set that day**.

Source: https://www.facebook.com/business/help/190490051321426

> **Gotcha that will burn a real budget.** The 175% ceiling anchors to the **highest** budget you set that day, not the current one. If your loop raises an ad set from $100 → $400 at 10:00 and rolls it back to $100 at 11:00, Meta may still spend up to $700 that day. A bug that briefly writes a large budget is not undone by writing the small one back. Rate-limit *upward* budget writes in your own code and treat them as irreversible for the calendar day.

The weekly ceiling resets **Saturday midnight in the ad account time zone**, not on a rolling 7-day window. A Friday budget increase has one day of runway before the reset.

### 2.2 Minimum budgets are currency-dependent and must be fetched

```
GET /v26.0/act_{AD_ACCOUNT_ID}/minimum_budgets
```
Returns `MinimumBudget` nodes with fields (verbatim descriptions):
- `currency` — *"The currency these budgets pertain to"*
- `min_daily_budget_high_freq` — *"The minimum daily budget for an ad set optimized for high frequency actions like clicks and likes."*
- `min_daily_budget_imp` — *"The minimum daily budget for an ad set optimized for impressions."*
- `min_daily_budget_low_freq` — lower-frequency actions (app installs, offer claims)
- `min_daily_budget_video_views` — *"The minimum daily budget for an ad set optimized for video views."*

Values are in the currency's minor units (docs example: `100` for USD = $1.00). Read-only edge.
Source: https://developers.facebook.com/docs/marketing-api/reference/minimum-budget/

An autonomous downscaling loop **must** clamp against these per-account values, not a hardcoded $1. Zero-decimal currencies (JPY, KRW) and Meta's `offset` handling are covered in `meta-api-foundations.md`.

### 2.3 Budget scheduling / high-demand periods

This is the one budget lever explicitly designed to be pre-planned rather than reactive — and it does **not** count as a manual budget edit at the moment it fires.

```
POST /v26.0/{CAMPAIGN_ID}/budget_schedules
POST /v26.0/{AD_SET_ID}/budget_schedules
GET  /v26.0/{CAMPAIGN_ID}/budget_schedules?time_start=...&time_stop=...
```

Create parameters (verbatim, all four required):

| Param | Type | Verbatim |
|---|---|---|
| `time_start` | int64 (unix) | *"When the increased budget should start"* |
| `time_end` | int64 (unix) | *"When the increased budget should end"* |
| `budget_value` | int64 | *"Actual budget increase, unit defined by BudgetValueType (e.g. 140 could be $140 or 140%)"* |
| `budget_value_type` | enum | **`ABSOLUTE`** or **`MULTIPLIER`** — *"Type of budget value (e.g. absolute or multiplier)"* |

Returns `{id}`. No Graph object is created on the campaign edge; read-after-write supported. The returned objects are `HighDemandPeriod` nodes.
Read filters: `time_start` *"Filters out any HDPs with stop time <= time_start"*; `time_stop` *"Filters out any HDPs with start time >= time_stop"*.

Sources: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/budget_schedules/ and https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/budget_schedules/

**Limits (verbatim from Meta's help centre):**
- *"You can set up a maximum of **50 high-demand periods per campaign or ad set**"*
- *"High-demand periods must be at least **three hours** in length or more"*
- *"the total budget cannot exceed **eight times the daily budget**"*
- *"Budget scheduling can only be used for campaigns with a **daily budget**."* — **not compatible with lifetime budgets**.

Source: https://www.facebook.com/business/help/633318028866693

`recurrence_type` / `weekly_schedule` do **not** appear in the v26.0 reference for either edge. **UNVERIFIED:** whether recurring HDPs can be expressed at all via API; if not, an autonomous system must write 50 discrete windows and refresh them.

> **Design note.** HDPs are the correct mechanism for known demand (paydays, weekends, a launch, a sale) because they are declared ahead of time and do not look like a mid-flight budget edit to the pacing system. They are the *wrong* mechanism for reactive scaling — you only get 50 per object and each needs a 3-hour minimum.

### 2.4 Meta's own stated limit on how often to change budget or bid

Verbatim, from the Marketing API pacing documentation:

> *"When you change budget, our systems have to learn the new optimal bid which takes time. During this time, your bids are not optimal and we can't maximize ROI. Therefore you should not change bid and budget **frequently**."*
>
> *"If you have to change these parameters, limit yourself to **2-3 times a day and only the early part of the day**."*
>
> *"This impacts pacing less than changing it often or later in a day."*

Source: https://developers.facebook.com/docs/marketing-api/bidding/overview/pacing-and-scheduling

This is the closest thing Meta publishes to a rate limit on optimization actions, and it is **behavioural, not enforced** — the API will happily accept 200 budget writes a day and quietly ruin delivery. Encode it: at most 2–3 budget/bid mutations per ad set per day, all before ~noon in the account time zone, with a minimum interval enforced in your scheduler (the native-rule analogue is `action_frequency`, in minutes).

### 2.5 Pacing and ad scheduling

`pacing_type` enum (verbatim): `standard` (default — *"Meta enters ads into every relevant auction and adjusts bids daily for smooth delivery"*), `no_pacing` (accelerated; *"removes pacing adjustments and enters ads at full maximum bid"*), `day_parting`.

`adset_schedule` — array of `{start_minute, end_minute, days[], timezone_type}` where `timezone_type` is `"user"` (viewer's timezone) or `"advertiser"`. Constraints: *"Times must be on the hour and at least one hour apart"* (4 hours minimum for Reach & Frequency). **Requires a lifetime budget.** The schedule applies in the **audience's** timezone by default, not the ad account's.

Documented warning, verbatim: *"Updating an ad set or ad group's schedule for controlling delivery based on a schedule results in suboptimal performance because frequent pausing/resuming of ads affects pacing negatively, which could result in under delivery."*

Source: https://developers.facebook.com/docs/marketing-api/bidding/overview/pacing-and-scheduling

> **Dayparting is a trap for an autonomous system.** It forces lifetime budgets (which disables budget scheduling, §2.3), it splits delivery across timezones you did not model, and Meta explicitly says schedule-driven pause/resume harms pacing. Prefer letting `standard` pacing find the hours.

---

## 3. Campaign Budget Optimization (Advantage+ campaign budget)

### 3.1 What it actually does

Verbatim: Advantage+ campaign budget *"automatically and continuously finds the best available opportunities for results across your ad sets and distributes your campaign budget in real time."* From the help centre: it *"continuously distributes in real time to ad sets with the best opportunities"*, and — critically — *"Advantage+ campaign budget may not spend your budget equally for each ad set."*

Sources: https://developers.facebook.com/docs/marketing-api/bidding/guides/advantage-campaign-budget/ , https://www.facebook.com/business/help/153514848493595

Enable by setting `daily_budget` **or** `lifetime_budget` at the **campaign** level. If it is disabled you must supply per-ad-set budgets via `adset_budgets`.

Campaign-level fields:
- `daily_budget` / `lifetime_budget`
- `bid_strategy` — `LOWEST_COST_WITHOUT_CAP`, `COST_CAP`, `LOWEST_COST_WITH_BID_CAP`, `LOWEST_COST_WITH_MIN_ROAS`
- `adset_bid_amounts` — **required** when `bid_strategy` is `LOWEST_COST_WITH_BID_CAP` or `COST_CAP`

Ad-set spend controls under CBO:
- `daily_spend_cap` — maximum daily spend for that ad set
- `daily_min_spend_target` — *"best effort, not guaranteed"*
- `lifetime_spend_cap`
- `lifetime_min_spend_target` — *"best effort, not guaranteed"*

**Hard limit, verbatim:** campaigns exceeding **70 ad sets** cannot modify `bid_strategy` or disable Advantage campaign budget.
Source: https://developers.facebook.com/docs/marketing-api/bidding/guides/advantage-campaign-budget/

### 3.2 Why an external reallocator fights the algorithm

Three independent mechanisms are in conflict:

1. **Pacing level.** *"When using campaign budget optimization, pacing occurs at the campaign level; otherwise at the ad set level."* (https://developers.facebook.com/docs/marketing-api/bidding/overview/pacing-and-scheduling). Setting `daily_spend_cap` on an ad set constrains the campaign-level pacer that was optimizing across all of them.
2. **Meta says so directly.** From the help centre: spend limits *"may be useful if you have specific budget requirements for an ad set while using Advantage+ campaign budget"*, but the feature **restricts the algorithm's flexibility**. (https://www.facebook.com/business/help/458847204894307)
3. **Measurement.** Verbatim: *"when you use Advantage+ campaign budget, it's important to analyze results at the campaign level, rather than at the ad set level."* An external reallocator that reads ad-set CPA and shifts budget accordingly is reading a number Meta has already deliberately distorted — the "bad" ad set may be cheap *because* it is starved, and starving it further is exactly what your loop will do. This is the classic CBO death spiral.

**When manual (ad-set-budget) control still wins:**
- **Mixed optimization goals or bid strategies in one campaign** — verbatim guidance: use ad set budgets when you have *"mixed optimization goals or bid strategies"*. CBO cannot compare a LPV-optimized ad set to a purchase-optimized one.
- **You need a guaranteed floor for a strategic segment** (a new geo, a brand-safety cell, an experiment arm). CBO will happily spend 0 on it.
- **You are running your own experiment** where every cell must get equal spend. CBO destroys the experiment by design.
- **Fewer than 2 ad sets.** Verbatim: CBO is *"best suited for campaigns with at least 2 ad sets."*

**Middle ground: ad set budget sharing.** For campaigns *without* campaign-level budgets, Meta can share *"up to 20% of your daily budget with other ad sets to improve performance."* Requires ≥2 simultaneously active ad sets; total campaign spend is unchanged whether sharing is on or off; the 175%/210% daily ceilings of §2.1 apply.
Source: https://www.facebook.com/business/help/1388266028979935
**UNVERIFIED:** the API field name that toggles ad set budget sharing. Not found in the v26.0 ad set/campaign references.

### 3.3 Recommended posture for this build

- **Default to CBO** with `LOWEST_COST_WITHOUT_CAP` and **no** ad-set spend limits. Let Meta reallocate.
- **Your loop operates on the campaign budget and on creative**, not on inter-ad-set allocation. Reallocation is Meta's job and Meta is better at it (it sees the auction; you see a 15-minute-stale CPA).
- **Break CBO only for experiments** (§7), where you need enforced equal spend, and there use separate campaigns with ad-set budgets rather than CBO + spend caps.
- **Never** read ad-set-level cost from a CBO campaign and feed it into a budget decision. Read it only for creative decisions (which ads to keep), and even then prefer ad-level reads.

---

## 4. Bidding levers

`bid_strategy` enum with verbatim descriptions and required companions:

| Value | Description | Companion field |
|---|---|---|
| `LOWEST_COST_WITHOUT_CAP` | *"Meta automatically bids on your behalf and gets you the lowest cost results."* No cost control | none |
| `COST_CAP` | *"get the most results possible while Meta strives to meet the cost per action you set"* — adherence **not guaranteed** | `bid_amount` (required) |
| `LOWEST_COST_WITH_BID_CAP` | Lowest cost subject to a hard auction bid ceiling | `bid_amount` (required) |
| `LOWEST_COST_WITH_MIN_ROAS` | *"Specific bidding option for value optimization"* | `bid_constraints.roas_average_floor` (required); **scaled ×10000**, valid range `[100, 10000000]` |

Settable at both campaign and ad set level. For iOS 14.5 campaigns using `COST_CAP` or `LOWEST_COST_WITH_MIN_ROAS`, *"the duration must be set to at least 3 days."*
Source: https://developers.facebook.com/docs/marketing-api/bidding/overview/bid-strategy/

> **`roas_average_floor` scaling is a day-of-debugging bug.** A 2.5× ROAS floor is `25000`, not `2.5` and not `250`. `bid_amount`, by contrast, is in the account currency's **minor units** (cents). Two different scaling conventions in the same object.

Bid/cost-control changes are on Meta's "may restart learning depending on magnitude" list (§6.2). Treat a bid-strategy *switch* (e.g. `LOWEST_COST_WITHOUT_CAP` → `COST_CAP`) as an always-significant edit; treat a `bid_amount` nudge as magnitude-dependent.

---

## 5. Ad rotation and impression allocation inside an ad set

### 5.1 Meta concentrates on a winner, fast, and does not tell you the split rule

Meta's stated behaviour: when one ad in an ad set gets more engagement than the others, Meta *"will run that ad more frequently to get better performance for your budget,"* which is why one ad ends up with most of the impressions. Meta's own suggested remedy for even distribution is blunt: *"To make your ads run more evenly, you can try putting each ad in its own ad set."*
~~Source: https://www.facebook.com/business/help/464145940405064~~ — **CORRECTED 2026-09-02: this URL is a hard 404 ("WHOOPS — That page doesn't exist"). The two quoted strings above could not be located in any live Meta page and must be treated as UNVERIFIED.**
**The mechanism is nonetheless confirmed from a live primary source**, "About the ad auction": Meta does not choose randomly between eligible ads — the winner is *"the ad with the highest total value,"* computed from advertiser bid, estimated action rates and ad quality, and *"an ad that's more relevant to a person could win an auction against ads with higher bids."* Within one ad set, the ad that accumulates impressions is the one winning on total value. The engineering consequence below is unchanged: **intra-ad-set impression share is an auction outcome, not a randomised allocation, so ad-level CPA in a shared ad set is confounded.**
Source: https://www.facebook.com/business/help/430291176997542

Meta simultaneously recommends **2+ ads per ad set**: *"If one ad is under-performing, the system will automatically deliver the higher-performing version, so the ad set overall has a better chance of delivering."*

And simultaneously warns against too many: from "About the learning phase" — *"Don't create excessive ads"* because *"the delivery system learns less about each ad and ad set."* Running too many ads at once is listed as a direct cause of **Learning limited**.
Sources: https://www.facebook.com/business/help/112167992830700 , https://www.facebook.com/business/help/269269737396981

**Engineering consequences:**

1. **Impressions inside an ad set are not a fair sample.** Ad-level CPA within one ad set is confounded — the winner got the good auctions. You cannot conclude "creative B is worse" from ad-level data in a shared ad set; you can only conclude "Meta chose A". This is an *exploitation* signal, not an *evaluation* signal.
2. **But exploitation is usually what you want.** For a system whose goal is CPA, Meta's fast concentration is a feature. Use ad-level data to *retire* losers (Meta already stopped serving them) and to *seed* the next creative generation, not to make causal claims.
3. **If you need causal creative claims, the unit of test is the ad set (or the campaign), not the ad.** One creative per cell, cells isolated. See §7.
4. **Do not over-stuff.** More than ~4–6 ads per ad set both fragments learning and produces ads with too few impressions to evaluate at all. Meta's A/B tool itself caps at 5 variants; the Ads Manager creative test caps at 7 copies.

### 5.2 The `ROTATE` execution type

The only *native* rotation primitive: verbatim, `ROTATE` *"Pauses the currently active ad, and activates the next ad by ID in the ad set."* Schedule-based rules only.
Source: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/execution-spec/

Read that literally: it is **round-robin by ad ID order**, one active ad at a time. It is not performance-aware. It is useful for exactly one thing — forcing an even-exposure rotation to defeat Meta's winner-concentration when you deliberately want serial exposure — and it defeats the delivery optimizer while doing so. Every activation/deactivation is also an ad-set composition change (see §6.2: *"Introduction of additional ads in the ad set"* is a significant edit).

**Verdict: do not use `ROTATE` for creative testing.** Use it, if at all, for compliance-style sequencing.

### 5.3 Dynamic Creative and the Flexible Ad Format

Two distinct mechanisms, often conflated:

**Dynamic Creative** — set `is_dynamic_creative: true` on the ad set, supply `asset_feed_spec` on the creative. Meta assembles combinations per impression and *"learns from the asset's performance across audiences."*
- Objectives: `OUTCOME_SALES`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_APP_PROMOTION`
- **One ad per ad set only.**
- `buying_type` must be `AUCTION` or blank.
- Incompatible with `sponsored_messages`.
- *"Cannot delete or archive individual Dynamic Creative ads; must archive the parent ad set instead."*
- Carousel format excludes `BODY_LABEL`, `CALL_TO_ACTION_TYPE_LABEL`, `LINK_URL_LABEL`, `CAPTION_LABEL`, `AD_FORMAT_LABEL`.
Source: https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/dynamic-creative/

**Flexible Ad Format** — newer, uses `creative_asset_groups_spec` (not `asset_feed_spec`) on `POST /act_{id}/ads`. *"group multiple creative assets — such as images, videos, and text — in a single ad"* and the delivery system picks. Constraints: ≥1 image or video per group; *"no more than 5 texts per text_type in a group"*; *"All call_to_actions provided must have the same type"*. Objectives supported: **`OUTCOME_SALES` and `OUTCOME_APP_PROMOTION` only**.
Source: https://developers.facebook.com/docs/marketing-api/flexible-ad-format/ (spec details also in `meta-video-creative.md`)

**Reporting consequence.** Asset-level breakdowns (`image_asset`, `video_asset`, `body_asset`, `title_asset`, `call_to_action_asset`, `description_asset`, `link_url_asset`, `ad_format_asset`) support **only** `impressions, clicks, spend, reach, actions, action_values`. No ROAS, no video retention curves.
Source: https://developers.facebook.com/docs/marketing-api/insights/breakdowns/

> **For a pipeline whose whole point is generating and evaluating video creative: do not use Dynamic Creative or Flexible Ad Format as the default.** One generated video = one ad = one clean row in the warehouse. DCO's combinatorics plus the asset-breakdown metric ceiling make it impossible to attribute a ROAS delta to a specific generated video. Reserve DCO for the copy/CTA layer *around* a fixed video, if at all. (This matches the conclusion already recorded in `meta-insights-measurement.md` §13.)

### 5.4 Is there an API for automatic creative refresh or scheduled creative rotation?

Short answer: **there is no documented, general-purpose scheduled creative rotation API.** What exists:

| Mechanism | Status | Notes |
|---|---|---|
| `execution_type: ROTATE` | Documented | round-robin by ID, schedule-only, one active ad at a time |
| `execution_type: UPDATE_CREATIVE` | **In the live v26.0 enum, undocumented** | required `execution_options` unknown |
| `execution_type: DCO` | **In the live v26.0 enum, undocumented** | presumably "enable dynamic creative" |
| `CREATIVE_FATIGUE` recommendation | Documented, applyable via API | `POST /act_{id}/recommendations` with `recommendation_signature`; optional `extra_data.object_selection`. Described as *"AI-generated creative refreshes"* |
| `ENABLE_ADVANTAGE_PLUS_CREATIVE` / `ENABLE_GEN_UNCROP` / `ENABLE_MUSIC` as rule *actions* | Appear in `AdRuleHistory.action` | confirms an auto-apply pathway exists |
| `degrees_of_freedom_spec.creative_features_spec.standard_enhancements.enroll_status = OPT_IN` | Documented | per-creative opt-in to Advantage+ creative enhancements — see `meta-video-creative.md` |
| `budget_schedules` | Documented | schedules **budget**, not creative |

**The honest engineering answer: build creative refresh in your own loop.** Detect fatigue (§8), generate a new video, `POST /act_{id}/adcreatives`, `POST /act_{id}/ads` into the *same* ad set, pause the fatigued ad. Note that both adding and removing an ad are significant edits (§6.2) — so batch the swap into a single maintenance window rather than trickling one ad at a time.

---

## 6. The learning phase and the significant-edit taxonomy

### 6.1 The thresholds Meta actually publishes

- *"Ad sets typically exit the learning phase after about **50 results in the week after the ad set's last significant edit**."* (https://www.facebook.com/business/help/112167992830700)
- Learning limited fires when the ad set is *"unlikely to receive approximately **50 optimization events within the week** following your last significant edit."* (https://www.facebook.com/business/help/269269737396981)
- **Shops ads exception:** *"a minimum of 17 purchases through your website and 5 through Meta"* (after 7 days).
- Delivery best practices restates it: the system requires *"around 50 optimized conversion events for each ad set"* to exit learning. (https://www.facebook.com/business/help/950694752295474)
- Causes of Learning limited (verbatim list): *small audience size, low budget, low bid or cost control, high auction overlap, infrequent optimization events, running too many ads simultaneously.*
- Meta's own fixes, in its stated order: **combine ad sets and campaigns** (*"help you get the results you need faster, which means you'll see stable results sooner"*), expand audience, raise budget, raise bid/cost control, switch to a more frequent optimization event (*"for example, moving from purchases to add-to-cart"*).

**API surface** (full detail in `meta-insights-measurement.md` §6.2): `learning_stage_info{status, conversions, last_sig_edit_ts, attribution_windows, dynamic_lp_status, dynamic_lp_conversions_threshold, dynamic_lp_days_threshold}` on the ad set node. `status` ∈ `LEARNING | SUCCESS | FAIL`; **`FAIL` is the API's name for "Learning limited"** — there is no `LEARNING_LIMITED` value.
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-learning-stage-info/

**Use `dynamic_lp_conversions_threshold` when populated, not the folklore 50.** Meta now publishes a per-ad-set threshold and a per-ad-set day threshold. Falling back to a hardcoded 50 is the second-best behaviour.

### 6.2 The official significant-edit list

Verbatim from Meta's "Significant edits and learning phase":

**Always restarts learning:**
- Modifications to **audience targeting** parameters
- Updates to **creative assets or ad content**
- Changes to your **optimization event** selection
- **Introduction of additional ads** in the ad set
- **Pausing an ad set for a week or more** (relearning begins upon resumption)
- Adjustments to **bidding approach** (bid strategy)

**May restart learning, depending on magnitude:**
- Ad set **spending caps**
- **Bid limits, cost-per-result targets, or return-on-ad-spend goals**
- **Budget amounts**

And the only quantitative guidance Meta gives, verbatim:
> *"if you increase your budget from $100 to $101, that isn't likely to cause one or more ad sets to reenter the learning phase. However, if you change your budget from $100 to $1000, one or more ad sets may reenter the learning phase."*

Also: with Advantage+ campaign budget, **campaign-level bid strategy changes can affect multiple ad sets**, while individual ad set edits do not affect sibling ad sets.

Source: https://www.facebook.com/business/help/316478108955072

> **There is no published percentage threshold.** The universally repeated "20%" figure appears in every practitioner blog and in none of Meta's documentation. Treat 20% as a prudent operating convention, not a documented rule. **The reliable signal is `last_sig_edit_ts`** — write your edit, then re-read `learning_stage_info` and check whether the timestamp moved. That converts folklore into a measurement.

### 6.3 Practical safe / unsafe table for an autonomous loop

| Action | Learning impact | API surface | Verdict for the loop |
|---|---|---|---|
| Rename campaign/ad set/ad | None (not on Meta's list) | `POST /{id}` `name` | Safe, unlimited |
| Add/remove `adlabels` | None (not on Meta's list) | `adlabels` | Safe — use labels as your control-plane metadata |
| Create a `budget_schedules` HDP | Not listed as an edit | `POST /{id}/budget_schedules` | Safe; preferred for planned scaling |
| Budget change small (≤ ~20%) | "may" — likely not | `daily_budget` | Safe ≤2–3×/day, early in day |
| Budget change large (≥ ~2×) | Likely restarts | `daily_budget` | Only outside a learning window; prefer a ladder of small steps |
| Change `bid_amount` | "may", magnitude-dependent | `bid_amount` | Same discipline as budget |
| Change `bid_strategy` | **Always** | `bid_strategy` | Rare, deliberate, with a 7-day quiet period after |
| Change `optimization_goal` | **Always** | `optimization_goal` | Treat as building a new ad set |
| Change targeting | **Always** | `targeting` | Treat as building a new ad set |
| Add a new ad to a live ad set | **Always** | `POST /act_{id}/ads` | Batch all creative swaps into one window |
| Pause an ad inside an ad set | Changes ad set composition; removal of creative is on the list | `POST /{ad_id}` `status=PAUSED` | Batch with adds |
| Pause the whole ad set <7 days | Not significant | `status=PAUSED` | Safe |
| Pause the whole ad set ≥7 days | **Always** on resume | | Archive and rebuild instead |
| Set `daily_spend_cap` under CBO | "may" (spending caps listed) **and** constrains the CBO pacer | | Avoid |

**The loop's cadence must therefore be structured, not continuous:**

1. **Guardrail tier (any time, minutes):** pause on hard spend cap, pause on policy/`issues_info`, pause on catastrophic frequency. These are non-significant or worth the reset.
2. **Budget tier (≤2–3×/day, before noon account time):** ±≤20% steps, clamped to `minimum_budgets`, skipped entirely if `learning_stage_info.status == "LEARNING"`.
3. **Creative tier (weekly maintenance window):** all adds/removals in one batch, then a mandatory quiet period of `max(7 days, dynamic_lp_days_threshold)`.
4. **Structural tier (targeting, optimization goal, bid strategy):** never edit — build a new ad set and shift budget across.

Meta's own decision gate, verbatim: *"Wait to edit your ad set until it's out of the learning phase."*

---

## 7. A/B testing and experiments

### 7.1 The Ad Study API

Still live and documented at v26.0. Creation is **at the business level**:

```
POST /v26.0/{BUSINESS_ID}/ad_studies
GET  /v26.0/{AD_STUDY_ID}
GET  /v26.0/{AD_STUDY_ID}/cells
GET  /v26.0/{AD_STUDY_ID}/objectives
GET  /v26.0/act_{AD_ACCOUNT_ID}/impacting_ad_studies   # studies affecting this account
```
Sources: https://developers.facebook.com/docs/marketing-api/reference/ad-study/ , https://developers.facebook.com/docs/marketing-api/guides/split-testing/ , https://developers.facebook.com/docs/marketing-api/reference/ad-account/

`AdStudy` read fields: `id`, `business`, `canceled_time`, `cooldown_start_time`, `created_by`, `created_time`, `description`, `end_time`, `name`, `observation_end_time`, `results_first_available_date`, `start_time`, `type`, `updated_by`, `updated_time`. Edges: `cells` (`AdStudyCell`), `objectives` (`AdStudyObjective`).

Create parameters:

| Param | Required | Notes |
|---|---|---|
| `name` | ✅ | |
| `start_time` | ✅ | integer unix |
| `end_time` | ✅ | integer unix |
| `cells` | ✅ | list of objects: `name`, `treatment_percentage`, and one of `campaigns` / `adsets` / `ads` (lift studies also accept `adaccounts` and `control_percentage`) |
| `type` | optional | enum: **`LIFT`, `SPLIT_TEST`, `CONTINUOUS_LIFT_CONFIG`, `GEO_LIFT`, `BACKEND_AB_TESTING`, `CREATIVE_SPEND_ENFORCEMENT`, `PORTFOLIO_OPTIMIZER`, `VERSION_CONTROL`** |
| `objectives` | optional | measurement targets |
| `description`, `confidence_level` (float), `client_business`, `cooldown_start_time`, `observation_end_time`, `viewers` (list<int>) | optional | |
| `creative_test_config` | optional | JSON — required for creative tests |

Errors: 100 invalid parameter, 200 permissions, 368 abusive/disallowed, 190 bad token.

Verbatim minimal split-test creation (from the split-testing guide):
```bash
curl \
 -F 'name="new study"' \
 -F 'description="test creative"' \
 -F 'start_time=1478387569' \
 -F 'end_time=1479597169' \
 -F 'type=SPLIT_TEST' \
 -F 'cells=[{name:"Group A",treatment_percentage:50,campaigns:[<CAMPAIGN_ID>]},
            {name:"Group B",treatment_percentage:50,campaigns:[<CAMPAIGN_ID>]}]' \
 -F 'access_token=<ACCESS_TOKEN>' \
 https://graph.facebook.com/<API_VERSION>/<BUSINESS_ID>/ad_studies
```

**Documented limits, verbatim:** *"Max concurrent studies per advertiser: 100"*, *"Max cells per study: 150"*, *"Max ad entities per cell: 100"*.
**Documented guidance, verbatim:** *"Select only one variable per test"*; *"The API automates audience division, ensures no overlap between groups."*
Source: https://developers.facebook.com/docs/marketing-api/guides/split-testing/

`type` for creative tests: **must be `SPLIT_TEST_V2`**, and you *"include the `creative_test_config` field in your request"* to *"opt into Creative Testing and define budget"* by providing daily or lifetime budget percentages.
**UNVERIFIED:** the exact `creative_test_config` key names and value ranges.

> **Doc inconsistency found by fact-check 2026-09-02 — do not miss this.** `SPLIT_TEST_V2` is **absent from the `type` enum published on the `AdStudy` reference page**, which lists only `LIFT, SPLIT_TEST, CONTINUOUS_LIFT_CONFIG, GEO_LIFT, BACKEND_AB_TESTING, CREATIVE_SPEND_ENFORCEMENT, PORTFOLIO_OPTIMIZER, VERSION_CONTROL`. Only the split-testing *guide* names `SPLIT_TEST_V2`. Two Meta pages disagree. Assume a `type=SPLIT_TEST_V2` create may be rejected as an invalid enum value (error 100) and probe before building on it.
> Also: the `AdStudy` reference and the Opportunity Score page both render their example endpoints at **`v25.0`**, not `v26.0`. That is Meta's stale doc boilerplate, not evidence of deprecation — v26.0 is confirmed the latest version (released 2026-07-29) in the Graph API changelog — but it means "the page renders at v26.0" is not, on its own, evidence of anything.

`LIFT` studies (Conversion Lift) remain **gated** — verbatim from the lift-studies guide: *"Conversion Lift Measurement is currently limited. Please contact your Meta Representative for information about obtaining access."* (already recorded in `meta-insights-measurement.md` §; do not design around it).

### 7.2 Duration and budget requirements

Meta does **not** publish a minimum spend for split tests in the API docs. It publishes duration guidance in the help centre:

- *"keep your A/B tests running for at least **2 weeks or up to 30 days**"* (best practices page)
- Minimum **7 days**; tests shorter than 7 days *"may produce inconclusive results"*; maximum **30 days**
- *"set a budget that will produce enough results to confidently determine a winning strategy"* — no number given
- The audience *"should not overlap with other concurrent Meta campaigns"* because *"overlapping audiences may result in delivery problems and contaminate test results"*

Sources: https://en-gb.facebook.com/business/help/290009911394576 , https://www.facebook.com/business/help/1738164643098669

### 7.3 How Meta picks a winner

Verbatim: winners are determined *"by comparing the cost per result of each campaign"* where the result is the event chosen at test creation. *"Meta simulates possible outcomes tens of thousands of times to determine how often winning outcomes would have won"* and *"statistically calculates a winner with a certain confidence percentage, or chance of similar results if your test was repeated."*

Meta explicitly acknowledges the winner may show a *higher* cost, attributing it to insufficient duration, insufficient results, or ignoring the recommended study length.

If there is no clear winner: *"the top performing versions that had a lower cost per result when compared against other metrics is shown"* plus *"a recap of the test and suggestions for next steps."*

Delivery: *"When your A/B test ends, you'll get an email with information about your results and a link to see the full details in Experiments."*

Sources: https://en-gb.facebook.com/business/help/166313650471318 , https://www.facebook.com/business/help/1376548572415613

> **No published confidence threshold.** `confidence_level` is a *create* parameter on `ad_studies` (float), so you can set your own; Meta does not publish the default. **UNVERIFIED:** default value and its exact meaning (posterior probability of superiority, presumably, given the simulation description). For an autonomous system this is a strong argument for computing your own posterior from raw Insights rather than trusting the study verdict.

### 7.4 The Ads Manager "creative test" (SPLIT_TEST_V2's UI face)

Concrete numbers, verbatim from Meta's help centre:
- *"You can create **2 to 7 copies**"* of an ad for testing.
- Use *"no more than **20% of your existing budget**"* on the test variations, spent daily.
- **Requires the "Highest volume" bid strategy** (= `LOWEST_COST_WITHOUT_CAP`). Cost cap / bid cap / min-ROAS campaigns cannot run a creative test.
- **No automation on the result:** *"The test does not make any automatic changes based on the results."* Test ads *"will continue to run in your existing campaign alongside the existing ads using the original campaign or ad set budget"* after the test ends.

Source: https://www.facebook.com/business/help/1423851372208214

That last bullet is the operationally important one: **the creative test does not pause losers and does not reallocate budget.** Any "act on the result" behaviour is yours to build. Combined with the bid-strategy restriction, this makes the native creative test unattractive for a system already running a COST_CAP or ROAS-floor strategy.

### 7.5 Where Meta's structural best practice conflicts with A/B rigor

This is the central tension of the whole build, and it is worth stating precisely.

| Classic A/B rigor wants | Meta's delivery system wants |
|---|---|
| Many small isolated cells, one variable each | **Consolidation** — *"Combine ad sets and campaigns"* to escape Learning limited |
| Equal, enforced budget per cell | **CBO** — unequal, continuously reallocated budget |
| Equal impressions per creative | Winner concentration inside an ad set |
| Stable conditions for the whole test window | 50 events/7 days per cell, or the cell is Learning limited and its data is unstable by Meta's own admission |
| Run to significance regardless of cost | Meta caps A/B tests at 30 days and warns short tests are inconclusive |
| Never touch the campaign mid-test | Learning phase punishes any edit, so you must not touch it — **these two agree**, for different reasons |

**The arithmetic that resolves it.** A valid cell needs ~50 optimization events in 7 days. At a $40 CPA that is **$2,000 per cell per week**. A 4-cell creative test therefore costs ~$8,000/week *before* you get one clean read. Below that spend, splitting into cells does not buy you rigor — it buys you four Learning-limited ad sets whose numbers are noise, which is strictly worse than one consolidated ad set with a winner picked by Meta.

**Therefore, budget-tiered experiment design:**

| Weekly account budget | Design |
|---|---|
| < ~$2k/wk | **No formal experiments.** One consolidated ad set, 3–5 ads, let Meta concentrate. Evaluate creative on ad-level `spend`/`impressions` share as a *revealed preference* signal, retire the starved, generate replacements. Accept that this is not causal. |
| ~$2k–$8k/wk | **Sequential, not parallel.** One consolidated ad set. Introduce new creative in a batch, quiet period, compare the ad set's post-batch window against its pre-batch window with a time-series test. Confounded by seasonality — mitigate by always keeping a stable control ad in the set. |
| > ~$8k/wk | **Parallel cells become affordable.** Either `ad_studies` `SPLIT_TEST` (Meta enforces non-overlap for you) or your own cells as sibling campaigns with fixed ad-set budgets and a shared `adlabel` marking the experiment. Prefer your own if you need a bid strategy other than Highest volume, or want to act on the result automatically. |

**Why "your own cells" usually beats `ad_studies`:** you control the stopping rule, you get raw Insights rows for a proper sequential test, you are not capped at 30 days, you are not forced onto `LOWEST_COST_WITHOUT_CAP`, and you can pause the loser the moment your posterior crosses threshold. What you lose is Meta's enforced audience non-overlap — you must replicate it with mutually exclusive `custom_audiences` or geo splits, and you should monitor **Auction Overlap Rate** (§8.4) to detect leakage.

### 7.6 Is split testing still supported? (asked explicitly)

**Yes, as of 2026-09-02.** Evidence:
- `AdStudy` reference renders at v26.0 with full create parameters. https://developers.facebook.com/docs/marketing-api/reference/ad-study/
- The Split Testing guide is live under `/docs/marketing-api/guides/split-testing/` with `SPLIT_TEST` / `SPLIT_TEST_V2` and the limits table.
- No split-test or ad-study entry appears in the v26.0 changelog. https://developers.facebook.com/docs/graph-api/changelog/version26.0/
- The Ads Manager A/B test and Experiments surfaces are documented and current.

Caveat: `LIFT`-type studies are rep-gated, and `cooldown_start_time` was deprecated in the older lift-study docs. The v26.0 `AdStudy` node still exposes `cooldown_start_time` as both a read field and a create param — **UNVERIFIED** whether it does anything for `SPLIT_TEST`.

---

## 8. Frequency, audience saturation, creative fatigue

### 8.1 Meta's two official fatigue states, with thresholds

Meta publishes actual thresholds for these, which is unusual and useful:

| Delivery status | Verbatim definition |
|---|---|
| **Creative limited** | *"cost per result is more than ads you ran in the past but less than twice"* the historical benchmark |
| **Creative fatigue** | *"cost per result is more than or equal to twice as much as ads"* previously performed |

Meta's three recommended actions: (1) develop new creative with *materially different* imagery/video while keeping the existing ads running; (2) broaden the audience; (3) enable Advantage+ creative.
Source: https://www.facebook.com/business/help/1346816142327858

Related, from the cost-per-result best-practices page: Meta flags an account when it *"predict[s] that your cost per result may be twice as much as your past ads, ad sets, campaigns or similar ads, ad sets or campaigns."*
Source: https://www.facebook.com/business/help/321695409726523

**These map to the `CREATIVE_LIMITED` and `CREATIVE_FATIGUE` recommendation types in the Recommendations API (§10) — which is how you read them programmatically.** There is no documented `delivery_status` enum value for them on the ad set node; `effective_status` does not carry them.

> **Implement the thresholds yourself as a fallback:** rolling 7-day cost-per-result for the ad, versus that ad's own best rolling 7-day window (or the ad set's trailing 28-day median). Ratio ≥ 1.0 → watch; ≥ 2.0 → replace. That mirrors Meta's own definition and does not depend on the recommendation being surfaced.

### 8.2 Frequency capping via API

```json
"frequency_control_specs": [
  {"event": "IMPRESSIONS", "interval_days": 7, "max_frequency": 3}
]
```
Verbatim field docs:
- `event` — *"Event name, only `IMPRESSIONS` currently."*
- `interval_days` — *"Interval period in days, between 1 and 90 (inclusive)"*
- `max_frequency` — *"The maximum frequency, between 1 and 90 (inclusive)"*

When optimizing towards `REACH` and no spec is given, the default is `{"event":"IMPRESSIONS","interval_days":1,"max_frequency":1}`.
Sources: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-frequency-control-specs/ , https://developers.facebook.com/docs/marketing-api/reachandfrequency/

**UNVERIFIED:** which optimization goals accept `frequency_control_specs` on `AUCTION` buying type in v26.0. Historically it was restricted to REACH / brand-awareness style goals and Reach & Frequency (reservation) buying; conversion-optimized auction ad sets typically reject it. Probe before relying on it. A frequency cap is also a targeting-adjacent edit — assume it restarts learning.

### 8.3 Measuring frequency distribution (not just the mean)

Mean `frequency` hides the tail. The `frequency_value` breakdown gives you the distribution — but with a hard constraint, verbatim: **`frequency_value` works exclusively with `reach`.** You cannot get spend, clicks or conversions broken down by frequency bucket in the same call.
Source: https://developers.facebook.com/docs/marketing-api/insights/breakdowns/

(`meta-insights-measurement.md` notes this breakdown also requires an Ads Manager opt-in on some accounts — a human step.)

### 8.4 Auction Overlap Rate

Verbatim definition: *"How frequently this ad set was removed from the auction because it overlapped in the auction with another of your ad sets."* Meta's example: at 5%, *"your ad set competed in 5% fewer auctions and had fewer opportunities to be shown to people."*
Source: https://www.facebook.com/business/help/714172578779451

High auction overlap is one of Meta's six listed causes of **Learning limited**. For an autonomous system that spins up ad sets per creative concept, self-inflicted overlap is the default failure mode, and it is invisible unless you look for it.
**UNVERIFIED:** whether Auction Overlap Rate is exposed as an Insights field or breakdown in v26.0. It is documented as an Ads Manager column only. If it is not in the API, the proxy signal is: multiple active ad sets in the same account with materially similar `targeting` specs — detect that structurally on your side.

### 8.5 Practitioner thresholds (secondary sources — use as priors, not truth)

Meta publishes no frequency threshold. The 2026 practitioner consensus, from multiple independent secondary sources:

- Cross-industry **median frequency ≈ 3.0**
- **Prospecting:** keep 7-day frequency **< 2**; caps of 2–3/week
- **Retargeting:** 3–8/week tolerable; caps of 5–7/week
- Fatigue fingerprint: **CTR falling while frequency rises, with conversion rate roughly flat** — repeated exposure hits click probability first
- Reported creative lifespan before fatigue signals: ~8–14 days at meaningful spend

Sources (all secondary, confidence: unverified-secondary): https://www.adamigo.ai/blog/meta-ads-frequency-benchmarks-when-ads-start-fatiguing , https://metricrig.com/answers/ad-frequency-cap-best-practices-2026/ , https://www.adsights.ai/blog/topics/creative-strategy/creative-fatigue-in-meta-ads-detection-and-management-strategies

**Recommendation:** do not hardcode these. Learn per-account fatigue curves from your own warehouse (CTR and CPA as a function of 7-day frequency), and use Meta's own ≥2× cost-per-result definition (§8.1) as the ground-truth trigger since it is the one Meta itself acts on.

---

## 9. Meta's stated best practices for structure (and where they bite)

From "Best Practices for Meta Ads Delivery" (https://www.facebook.com/business/help/950694752295474), verbatim highlights:

- **Budget:** *"Opt into Advantage+ campaign budget"* — it *"automatically manages your campaign budget across ad sets to get you the best overall results."*
- **Audience:** use Advantage+ detailed targeting so the system can expand beyond your selections.
- **Placements:** use Advantage+ placements, *"or alternatively manually select at least 6+ placements."*
- **Creative:** the system surfaces *"Creative limited"* or *"Creative fatigue"* when audiences have seen the same creative too often — refresh.
- **Learning:** *"around 50 optimized conversion events for each ad set"*; **consolidate similar ad sets** to shorten learning.
- **Goal:** pick a performance goal that matches the business goal.
- **Prune:** *"advertisers are often more efficient when they turn off ads that aren't producing outcomes."*

The through-line of every current Meta recommendation is **consolidate and delegate**: fewer ad sets, broader audiences, all placements, campaign-level budget, Meta picks the creative combination. That is optimal for Meta's optimizer and directly hostile to a system that wants attributable, per-creative causal reads.

**Resolution for this build:** delegate everything Meta is measurably better at (audience expansion, placement selection, inter-ad-set budget allocation, intra-ad-set impression allocation) and keep only the one decision Meta cannot make for you — **which creative to generate next**. Structure the account so that creative identity survives: one generated video = one ad object = one row; no DCO; ad-level Insights as the creative feedback signal; consolidation everywhere else.

---

## 10. Opportunity Score & Recommendations API — Meta's own optimizer, exposed

This is the newest and most directly actionable optimization surface, expanded in a 2025-11-10 announcement and again in March 2026.

```
GET  /v26.0/act_{AD_ACCOUNT_ID}/recommendations
POST /v26.0/act_{AD_ACCOUNT_ID}/recommendations      # apply
GET  /v26.0/{BUSINESS_ID}/recommendations            # portfolio-wide
```
Sources: https://developers.facebook.com/docs/marketing-api/overview/performance-recommendations/ , https://developers.facebook.com/blog/post/2025/11/10/unlock-peak-performance-with-new-opportunity-score-features-in-the-marketing-api/

**Account-level response fields:** `ad_account_id` (business requests only), **`opportunity_score` (0–100)**, `recommendations[]`. Verbatim: *"A higher score indicates better optimality and a greater likelihood of improved performance over time."* Updates in near real-time.

**Per-recommendation fields:** `recommendation_signature` (required to apply), `recommendation_stage` (`pre_create_guidance`, `pre_flight_recommendation`, `mid_flight_recommendation`), `recommendation_time` (ISO 8601), `recommendation_name`, `type`, `level` (`ad`/`ad_set`/`campaign`/`ad_account`), `object_ids`, `lift_estimate`, `body`, `opportunity_score_lift`, `url` (deep link into Ads Manager).

> **Added by fact-check 2026-09-02 — the two identifier fields are not both always present.** The reference marks **`type` as returned on ad-account requests only** and **`recommendation_name` as returned on business-level requests only**. A multi-tenant collector that fans out via `GET /{business_id}/recommendations` and then keys its whitelist off `type` will get **nothing back to match on** — it must match on `recommendation_name` (snake_case) instead, or re-fetch per account. This is a real integration bug waiting to happen.

**Request filters:** `recommendation_stages` (`mfr`, `pcr`, `mid_flight_recommendation`, `pre_create_guidance`), `recommendation_names` (snake_case), `ad_account_ids` (max 100, business requests), `locale`.

**Apply:**
```bash
curl -X POST \
  -d 'access_token=<ACCESS_TOKEN>' \
  -d 'recommendation_signature="1234567"' \
  -d 'extra_data={"object_selection": "7656787679008"}' \
  https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/recommendations
```
Success returns a boolean.

**The 14 apply-via-API types and their `extra_data`:**

| `type` | Parameters |
|---|---|
| `ADVANTAGE_PLUS_AUDIENCE` | none |
| `APLUSC_STANDARD_ENHANCEMENTS_BUNDLE` | `object_selection` (opt), `creative_feature_opt_in_overrides` (opt) |
| `AUTOFLOW_OPT_IN` | `object_selection` (opt) |
| `AUTOMATIC_PLACEMENTS` | none |
| `BACKGROUND_GENERATION` | `action_type` (**required**: `"OPT_IN"` / `"OPT_OUT"`), `object_selection` (**required**) |
| `CONVERSION_LEADS_OPTIMIZATION` | none |
| **`CREATIVE_FATIGUE`** | `object_selection` (opt) |
| `LANDING_PAGE_VIEW_OPTIMIZATION_GOAL` | none |
| `MUSIC` | `object_selection` (opt) |
| `PERFORMANT_CREATIVE_REELS_OPT_IN` | `object_selection` (opt) |
| `PRODUCT_SET_BOOSTING` | none |
| **`SCALE_GOOD_CAMPAIGN`** | `adsets` (opt JSON array), `campaigns` (opt JSON array) |
| `SHOPS_ADS_SAOFF` | `object_selection` (opt) |
| `UNCROP_IMAGE` | `object_selection` (opt) |

**Full type list — 37 documented types (corrected 2026-09-02; the earlier draft said "44+", which is not supported by the page. Counted from the live list below: 37. 14 of them are applyable, so 23 are read-only):** `ADVANTAGE_PLUS_AUDIENCE, ADVANTAGE_PLUS_CATALOG_ADS, APLUSC_ADD_OVERLAYS, APLUSC_STANDARD_ENHANCEMENTS_BUNDLE, APLUSC_TEXT_IMPROVEMENTS, APLUSC_VISUAL_TOUCHUPS, AUTOFLOW_OPT_IN, AUTOMATIC_PLACEMENTS, BACKGROUND_GENERATION, BUDGET_LIMITED, CAPI_CRM_GUIDANCE_V2, CAPI_CRM_SETUP, CAPI_PERFORMANCE_MATCH_KEY_V2, CONVERSION_LEADS_OPTIMIZATION, CREATIVE_FATIGUE, CREATIVE_LIMITED, CTX_CREATION_PACKAGE, FRAGMENTATION_V3, GEN_AI_MVP, LANDING_PAGE_VIEW_OPTIMIZATION_GOAL, MESSAGING_EVENTS, MESSAGING_PARTNERS, MULTI_TEXT, MUSIC, OFFSITE_CONVERSION, PARTNERSHIP_ADS, PERFORMANT_CREATIVE_REELS_OPT_IN, PIXEL_OPTIMIZATION_HIE, PIXEL_UPSELL, PRODUCT_SET_BOOSTING, SCALE_GOOD_CAMPAIGN, SHOPS_ADS_SAOFF, SIGNALS_GROWTH_CAPI_V2, UNCROP_IMAGE, UNIFIED_INBOX, VALUE_OPTIMIZATION_GOAL, WA_MESSAGING_PARTNERS`

**Why this matters more than the rules engine for this build:**

- `CREATIVE_FATIGUE` and `CREATIVE_LIMITED` are Meta telling you, with its own threshold (§8.1), exactly which ads to replace. That is a free, high-precision trigger for the video-generation pipeline.
- `BUDGET_LIMITED` and `SCALE_GOOD_CAMPAIGN` are Meta telling you where headroom exists — a far better scaling signal than your own CPA read, because Meta sees the auction supply curve.
- `FRAGMENTATION_V3` and the `CONSOLIDATE_FRAGMENTATION` rule action are Meta detecting the exact self-inflicted auction overlap an automated ad-set spawner creates.
- `opportunity_score` gives you a single per-account scalar to alarm on and to include as a feature in your own model.

**Caveats, verbatim:** *"Not all recommendations appearing in Ads Manager UI return via API"*; *"Recommendations expire; stale signatures will fail when applied"*; business-level requests paginate at 100 accounts per page.

> **Design rule:** fetch recommendations on every sync, store `recommendation_signature` with a short TTL, and apply only from a whitelist you have explicitly opted into. Blindly applying everything will enable Advantage+ Audience and Advantage+ Placements on ad sets you deliberately constrained — and each of those is a **targeting change**, i.e. a learning-phase reset (§6.2).

**Related but distinct: pre-flight validation.** `execution_options` on create/update accepts `validate_only` and `include_recommendations`; the latter *"cannot be used by itself and requires specifying the `validate_only` flag with it"*, and returns a `recommendations` section alongside soft errors such as *"Your targeting is too narrow"* / *"your bid is too low"*. On GET, `recommendations` is a plain field. Ad and ad set nodes expose `recommendations` (`list<AdRecommendation>`), `issues_info`, `failed_delivery_checks` and `ad_review_feedback`.
Sources: https://developers.facebook.com/ads/blog/post/v2/2016/02/18/recommendations-api/ , https://developers.facebook.com/docs/marketing-api/reference/adgroup/
**UNVERIFIED:** whether the 2016 `validate_only` + `include_recommendations` contract is unchanged at v26.0; the dedicated validation doc page 404s.

---

## 11. Gotchas

1. **Error 2703 — "Rules that turn off ads can't have cost conditions."** The obvious CPA-pause rule cannot be created natively. Your own loop is not restricted. This alone decides the architecture.
2. **Native rules silently self-disable.** `status` flips and `disable_error_code` populates. Poll it; do not assume your guardrails are armed.
3. **`entity_type` rules retroactively adopt new objects.** A rule written in January acts on ad sets your pipeline creates in September, including ones in a protected learning window. Use `id`-scoped rules or `hours_since_creation` filters for anything destructive.
4. **The implicit `effective_status` filter is execution-type-dependent.** ~~It means `UNPAUSE` rules do nothing unless you override it.~~ **Corrected:** active-object execution types get `IN ['ACTIVE','PENDING_REVIEW']`; `UNPAUSE` and other non-active types get `NOT_IN ['DELETED','ARCHIVED']`. So an `UNPAUSE` rule *does* see paused objects — and will happily reactivate objects **your own loop deliberately paused**. Scope `UNPAUSE` rules by `id`/`adlabel_ids`, or archive rather than pause. (§1.2)
5. **One `time_preset` per rule, applied to every stats filter including the trigger.** You cannot express "CPA over 7 days AND spend today > X" in one native rule.
6. **Many `time_preset` values include today's partial data** by design. A CPA rule evaluated at 09:00 sees a full morning of spend against almost no attributed conversions. Add a `spent`/`impressions` floor and an `hours_since_creation` floor to every cost-shaped rule.
7. **`SEMI_HOURLY` is the ceiling.** 30 minutes is the fastest a scheduled rule can run; `start_minute`/`end_minute` must be multiples of 30.
8. **`change_spec.unit` is `ACCOUNT_CURRENCY | PERCENTAGE`. `budget_schedules.budget_value_type` is `ABSOLUTE | MULTIPLIER`.** Different enums for conceptually similar things, in adjacent APIs.
9. **`action_frequency` is in minutes** (`10080` = 1 week), while `interval_days` on frequency control is in days and `start_minute` is minutes-after-midnight. Three time units in one subsystem.
10. **`roas_average_floor` is scaled ×10000** (2.5× → `25000`), while `bid_amount` is in currency minor units. Getting this wrong sets a 0.00025× ROAS floor and spends everything.
11. **The 175% daily overspend ceiling anchors to the highest budget set that day.** A briefly-written large budget is not undone by writing it back down. Guard upward budget writes.
12. **The weekly 7× ceiling resets Saturday midnight account time**, not on a rolling window.
13. **Budget scheduling requires a daily budget.** Ad scheduling (`adset_schedule` / `pacing_type=day_parting`) requires a **lifetime** budget. You cannot have both on one ad set.
14. **`adset_schedule` runs in the audience's timezone by default** (`timezone_type: "user"`), not the account's.
15. **Meta's own written limit on optimization actions is "2-3 times a day and only the early part of the day."** The API enforces nothing. Enforce it yourself.
16. **CBO campaigns with >70 ad sets cannot change `bid_strategy` or turn CBO off.** A runaway ad-set spawner can permanently lock a campaign's configuration.
17. **Ad-set-level cost under CBO is a distorted number.** Never feed it into a budget decision.
18. **Adding one ad to a live ad set restarts learning for the whole ad set.** Batch creative swaps; never trickle.
19. **Pausing an ad set for ≥7 days restarts learning on resume.** For anything longer than a week, archive and rebuild rather than pause/resume.
20. **`learning_stage_info.status = FAIL` means "Learning limited", not "error".** There is no `LEARNING_LIMITED` enum value. Verbatim from the reference: `FAIL` = *"The ad set isn't generating enough results to exit the learning phase."*
21. **Rule creation is itself rate-limited per ad account** — error **80004**, *"There have been too many calls to this ad-account. Wait a bit and try again."* Back off when provisioning guardrail rules across many accounts. (§1.8)
22. **`type` is absent from business-level recommendation responses; `recommendation_name` is absent from ad-account-level ones.** Match your apply-whitelist on the field the call actually returns. (§10)
23. **`SPLIT_TEST_V2` is not in the `AdStudy` reference's `type` enum** even though the split-testing guide requires it for creative tests. Two Meta pages disagree; probe before building. (§7.1)
21. **There is no published percentage threshold for a "significant" budget edit.** The 20% figure is folklore. Use `last_sig_edit_ts` as the oracle: write, re-read, compare.
22. **`frequency_value` breakdown works only with `reach`.** You cannot cross frequency buckets with spend or conversions in one call.
23. **Asset-level creative breakdowns support only `impressions, clicks, spend, reach, actions, action_values`.** No ROAS, no video retention. This is why DCO is wrong for a generated-video pipeline.
24. **Dynamic Creative ad sets allow exactly one ad, and individual DCO ads cannot be deleted or archived** — you must archive the parent ad set.
25. **The Ads Manager creative test requires "Highest volume" (`LOWEST_COST_WITHOUT_CAP`)** and makes **no automatic changes** to your campaign when it concludes.
26. **`PING_ENDPOINT` webhooks are subscribed at the *application* level and carry no ad account id.** Multi-tenant systems must maintain their own `object_id → tenant` index.
27. **250 automated rules per ad account; one rule cannot span two object levels; one of each condition per rule.**
28. **100,000 archived objects per ad account per object type.** A system that generates ads continuously will hit this; move old archived objects to `DELETED`, and note that *"once an object status is set to `DELETED`, you cannot set it back to `ARCHIVED`"*, so snapshot stats first. (https://developers.facebook.com/documentation/ads-commerce/marketing-api/best-practices/manage-your-ad-object-status)
29. **Recommendation signatures expire.** Fetch → apply in the same cycle; never persist a signature across runs.
30. **Applying `ADVANTAGE_PLUS_AUDIENCE` or `AUTOMATIC_PLACEMENTS` is a targeting change** and therefore a learning-phase reset. Whitelist what you auto-apply.
31. **v25.0 blocked creation/duplication/update of Advantage+ shopping and Advantage+ app campaigns via `POST /act_{id}/campaigns` and `/copies` as of 2026-05-19** (see `meta-api-foundations.md` §1.4). If your optimizer's scaling path assumed "duplicate the winning ASC campaign," it does not exist.
32. **Automated rules cannot act on social-issue/election/political ads, and cannot pause reservation campaigns.**

---

## 12. Open questions / UNVERIFIED

1. **`DELIVERY_INSIGHTS_CHANGE` trigger type.** Present in the v26.0 `adrules_library` create enum; no guide text. If it fires on "Creative limited / Creative fatigue / Learning limited" transitions it is the single best fatigue trigger available. **Probe it.**
2. **The ten undocumented `execution_type` values** — `UPDATE_CREATIVE`, `DCO`, `AD_RECOMMENDATION_APPLY`, `AUDIENCE_CONSOLIDATION`, `AUDIENCE_CONSOLIDATION_ASK_FIRST`, `ADD_INTEREST_RELAXATION`, `ADD_QUESTIONNAIRE_INTERESTS`, `INCREASE_RADIUS`, `UPDATE_LAX_BUDGET`, `UPDATE_LAX_DURATION`. Enum membership is verified; required `execution_options` are not.
3. **`rebalance_spec` exact shape.** The key name for the rebalance type, and whether `PROPORTIONAL` is a literal value alongside `NO_PAUSE_PROPORTIONAL` and `MATCHED_ONLY_PROPORTIONAL`. Reference page 404s.
4. **Ad rule `preview` and `execute` endpoint paths.** Both announced (2017, 2018); `is_manual` on `AdRuleHistory` proves manual execution exists; both reference pages 404 at v26.0.
5. **Advanced-filter syntax** (prefixed insights fields, aggregation, formulas). Announced 2018; doc page 404s.
6. **`creative_test_config` key names and value ranges** for `SPLIT_TEST_V2`.
7. **Default `confidence_level`** on `ad_studies`, and the precise statistic behind Meta's "confidence percentage."
8. **Whether `cooldown_start_time` has any effect on `SPLIT_TEST`** (it was deprecated in lift studies but is still a v26.0 create param).
9. **Whether `POST /act_{id}/ad_studies` is supported** or whether business-level creation is the only path. The v26.0 Ad Account edge list retrieved shows `impacting_ad_studies` but not `ad_studies` — the extraction may be truncated.
10. **The API field that toggles Ad Set Budget Sharing.** Documented in the help centre (20% / 210%); no matching field found in the v26.0 ad set or campaign references.
11. **`recurrence_type` / `weekly_schedule` on `budget_schedules`.** Not in the v26.0 reference for either campaign or ad set. If recurring HDPs are impossible via API, the 50-per-object limit becomes a real constraint.
12. **Whether `frequency_control_specs` is accepted on `AUCTION` ad sets with conversion optimization goals** in v26.0.
13. **Whether Auction Overlap Rate is exposed anywhere in the Insights API**, or is Ads Manager-only.
14. **`validate_only` + `include_recommendations` contract at v26.0.** The 2016 announcement describes it; the dedicated validation doc page 404s.
15. **Maximum number of ad rules the API will accept vs. the 250 the UI documents** — the API reference publishes no limit; assume 250 is shared.
16. **Whether `PAUSE`/`UNPAUSE` executed by a native rule stamps `last_sig_edit_ts`** the same way an API write does. Material for reconciling learning-phase state across two actors.
17. **`dynamic_lp_status` enum values** (carried over from `meta-insights-measurement.md` — still undocumented).
18. **The "one ad getting more impressions" help article body.** The behaviour is well-attested via search indexing but the article would not render through the text proxy; treat §5.1's quotes as verified-secondary.

---

## 13. Source index

**Official — developers.facebook.com**
- Ad Rules Engine overview: https://developers.facebook.com/docs/marketing-api/ad-rules
- Evaluation spec: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/evaluation-spec/
- Execution spec: https://developers.facebook.com/docs/marketing-api/ad-rules/overview/execution-spec/
- Trigger-based rules (+ webhook payload): https://developers.facebook.com/docs/marketing-api/ad-rules/guides/trigger-based-rules/
- Schedule-based rules: https://developers.facebook.com/docs/marketing-api/ad-rules/guides/scheduled-based-rules/
- Advanced scheduling: https://developers.facebook.com/docs/marketing-api/ad-rules/guides/advanced-scheduling
- change_spec examples: https://developers.facebook.com/docs/marketing-api/ad-rules-examples/change-spec
- AdRule node: https://developers.facebook.com/docs/marketing-api/reference/ad-rule/
- AdRule history (+ action enum): https://developers.facebook.com/docs/marketing-api/reference/ad-rule/history/
- adrules_library create reference (full enums): https://developers.facebook.com/docs/marketing-api/reference/ad-account/adrules_library/
- AdRuleExecutionOptions: https://developers.facebook.com/docs/marketing-api/reference/ad-rule-execution-options/
- adrules_governed: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/adrules_governed
- Ad Rules Engine announcements: https://developers.facebook.com/ads/blog/post/v2/2017/04/18/ads-rules-engine/ , https://developers.facebook.com/ads/blog/post/2017/11/08/ad-rules-engine-blog-post/ , https://developers.facebook.com/ads/blog/post/v2/2018/04/25/new-features-ad-rules-engine/
- Pacing & scheduling (budget-change guidance): https://developers.facebook.com/docs/marketing-api/bidding/overview/pacing-and-scheduling
- Bid strategies: https://developers.facebook.com/docs/marketing-api/bidding/overview/bid-strategy/
- Advantage campaign budget: https://developers.facebook.com/docs/marketing-api/bidding/guides/advantage-campaign-budget/
- Campaign budget_schedules: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/budget_schedules/
- Ad set budget_schedules: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/budget_schedules/
- MinimumBudget node: https://developers.facebook.com/docs/marketing-api/reference/minimum-budget/
- Ad Account minimum_budgets edge: https://developers.facebook.com/docs/marketing-api/reference/ad-account/minimum_budgets/
- Split Testing guide: https://developers.facebook.com/docs/marketing-api/guides/split-testing/
- AdStudy node: https://developers.facebook.com/docs/marketing-api/reference/ad-study/
- AdStudy cells edge: https://developers.facebook.com/docs/marketing-api/reference/ad-study/cells/
- Learning stage info: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-learning-stage-info/
- Ad Set node: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/
- Ad node (issues_info, recommendations, effective_status): https://developers.facebook.com/docs/marketing-api/reference/adgroup/
- Ad Account node (edges): https://developers.facebook.com/docs/marketing-api/reference/ad-account/
- Frequency control specs: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-frequency-control-specs/
- Insights breakdowns: https://developers.facebook.com/docs/marketing-api/insights/breakdowns/
- Dynamic Creative: https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/dynamic-creative/
- Flexible Ad Format: https://developers.facebook.com/docs/marketing-api/flexible-ad-format/
- Opportunity Score & Recommendations: https://developers.facebook.com/docs/marketing-api/overview/performance-recommendations/
- Opportunity score announcement (2025-11-10): https://developers.facebook.com/blog/post/2025/11/10/unlock-peak-performance-with-new-opportunity-score-features-in-the-marketing-api/
- Recommendations API announcement (validate_only): https://developers.facebook.com/ads/blog/post/v2/2016/02/18/recommendations-api/
- Manage ad object status (archive/delete limits): https://developers.facebook.com/documentation/ads-commerce/marketing-api/best-practices/manage-your-ad-object-status
- Graph API v26.0 changelog: https://developers.facebook.com/docs/graph-api/changelog/version26.0/

**Official — Meta Business Help Centre** (JS-rendered; retrieved via text-extraction proxy of these canonical URLs)
- Significant edits and learning phase: https://www.facebook.com/business/help/316478108955072
- About the learning phase: https://www.facebook.com/business/help/112167992830700
- About learning limited: https://en-gb.facebook.com/business/help/269269737396981
- Best practices for Meta ads delivery: https://www.facebook.com/business/help/950694752295474
- Creative fatigue recommendations: https://www.facebook.com/business/help/1346816142327858
- Reduce cost per result: https://www.facebook.com/business/help/321695409726523
- About daily budgets: https://www.facebook.com/business/help/190490051321426
- About lifetime budgets: https://en-gb.facebook.com/business/help/1844835042445690
- About budget scheduling: https://en-gb.facebook.com/business/help/633318028866693
- About Advantage+ campaign budget: https://www.facebook.com/business/help/153514848493595
- Campaign budgets vs ad set budgets: https://www.facebook.com/business/help/458847204894307
- About ad set budget sharing: https://www.facebook.com/business/help/1388266028979935
- Limits to automated rules: https://www.facebook.com/business/help/222640851458826
- About automated rules: https://en-gb.facebook.com/business/help/1694779440789213
- About A/B testing: https://www.facebook.com/business/help/1738164643098669
- A/B test best practices: https://en-gb.facebook.com/business/help/290009911394576
- How winners are determined: https://en-gb.facebook.com/business/help/166313650471318
- Viewing A/B test results: https://www.facebook.com/business/help/1376548572415613
- Set up a creative test: https://www.facebook.com/business/help/1423851372208214
- Auction overlap rate: https://www.facebook.com/business/help/714172578779451
- One ad getting more impressions: https://www.facebook.com/business/help/464145940405064

**Secondary (labelled as such in text)**
- https://www.adamigo.ai/blog/meta-ads-frequency-benchmarks-when-ads-start-fatiguing
- https://metricrig.com/answers/ad-frequency-cap-best-practices-2026/
- https://www.adsights.ai/blog/topics/creative-strategy/creative-fatigue-in-meta-ads-detection-and-management-strategies

---

## Fact-check log

**Adversarial re-verification pass — 2026-09-02.** Every claim below was re-checked against Meta primary sources (`developers.facebook.com/docs/*`, `facebook.com/business/help/*` via the `r.jina.ai` text proxy, and the Graph API changelog). Claims were assumed wrong until a primary page produced the string. WebSearch quota was exhausted mid-pass; everything below was verified by direct fetch of the cited URL.

### Baseline
- **Graph API v26.0 is the current latest version, released 2026-07-29.** CONFIRMED against https://developers.facebook.com/docs/graph-api/changelog (v25.0 = 2026-02-18, v24.0 = 2025-10-08). The document's header is correct.

### CONFIRMED without change

| # | Claim | Source |
|---|---|---|
| 2 | `execution_type` enum is **19** values (`DCO … AD_RECOMMENDATION_APPLY`); the guide documents only **9**; therefore 10 are undocumented. Both lists reproduced exactly. | [adrules_library ref](https://developers.facebook.com/docs/marketing-api/reference/ad-account/adrules_library/) + [execution-spec guide](https://developers.facebook.com/docs/marketing-api/ad-rules/overview/execution-spec/) |
| 3a | *"All filters are evaluated together using the `AND` operator."* | [evaluation-spec](https://developers.facebook.com/docs/marketing-api/ad-rules/overview/evaluation-spec/) |
| 3b | *"Currently, we only allow one `time_preset`. It applies to all stats filters in the rule, including the one used for the trigger, if present."* | as above |
| 4 | `entity_type` scoping is dynamic: *"that rule automatically evaluates every new ad that added to the ad account. This happens regardless of when you create the rule."* `id` scoping is static. | as above |
| 5 | `trigger.type` = exactly 5 values (`METADATA_CREATION, METADATA_UPDATE, STATS_MILESTONE, STATS_CHANGE, DELIVERY_INSIGHTS_CHANGE`). Latency verbatim: *"metadata changes is usually a few seconds, and the latency for insights changes is usually within a few minutes (current p99 is about 7.5 minutes)."* API-only: *"Trigger Based Rules are only available in API at this point, they are not accessible through Ads Manager."* | [trigger-based-rules](https://developers.facebook.com/docs/marketing-api/ad-rules/guides/trigger-based-rules/) |
| 6 | `PING_ENDPOINT` subscribed at **application** level with an **app access token** against `/{APP_ID}/subscriptions`, `fields=ads_rules_engine`. Payload value keys `{rule_id, object_id, object_type, trigger_type, trigger_field, current_value}` — **no ad account id present.** Curl and JSON reproduce exactly. | as above |
| 7 | *"you should not change bid and budget frequently"* / *"If you have to change these parameters, limit yourself to 2-3 times a day and only the early part of the day."* Behavioural, not API-enforced. | [pacing-and-scheduling](https://developers.facebook.com/docs/marketing-api/bidding/overview/pacing-and-scheduling) |
| 8 | 75% daily overspend, 7× weekly ending **Saturday at midnight**, 20%/210% with ad set budget sharing, and the mid-day anchor: *"the spending limit is 75% more than the highest daily budget in place that day."* The "briefly-written large budget is not undone" consequence holds. | [help/190490051321426](https://www.facebook.com/business/help/190490051321426) |
| 9 | *"maximum of 50 high demand periods per campaign or ad set"*, *"at least 3 hours in length or more"*, *"total budget cannot exceed 8 times the daily budget"*, *"Budget scheduling can only be used for campaigns with a daily budget."* Create params `time_start, time_end, budget_value, budget_value_type (ABSOLUTE\|MULTIPLIER)` all present. | [help/633318028866693](https://www.facebook.com/business/help/633318028866693) |
| 10 | Significant-edit list confirmed item-for-item (targeting, creative, optimization event, adding an ad, pausing ≥7 days, bid strategy = always; spending limit, bid/cost/ROAS control, budget amount = magnitude-dependent). $100→$101 and $100→$1000 sentences verbatim. **No percentage threshold appears anywhere on the page — the folkloric 20% is confirmed absent.** | [help/316478108955072](https://www.facebook.com/business/help/316478108955072) |
| 11 | `learning_stage_info` fields confirmed: `attribution_windows, conversions, dynamic_lp_conversions_threshold, dynamic_lp_days_threshold, dynamic_lp_status, last_sig_edit_ts, status`. `status` ∈ `LEARNING\|SUCCESS\|FAIL`; **no `LEARNING_LIMITED` value exists.** `last_sig_edit_ts` verbatim: *"Timestamp of the last significant edit that caused ad set to reenter the learning phase."* The "write, re-read, check whether the timestamp moved" technique is sound. | [learning-stage-info ref](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-learning-stage-info/) |
| 12 | *"about 50 results in the week after the ad set's last significant edit"*; Shops ads *"a minimum of 17 purchases through your website and 5 through Meta"*; Learning-limited definition and its six causes (incl. *"running too many ads at the same time"*); Meta's fix order starts with **"Combine ad sets and campaigns."** | [help/112167992830700](https://www.facebook.com/business/help/112167992830700), [help/269269737396981](https://www.facebook.com/business/help/269269737396981), [help/950694752295474](https://www.facebook.com/business/help/950694752295474) |
| 13 | *"You can create up to 250 automated rules on a single ad account"*, *"You can only add one of each condition per rule"*, one level per rule (*"you could apply a single rule to three campaigns or to three ad sets, but you can't apply a single rule to three campaigns and three ad sets"*), no social-issue/election/political ads, cannot pause reservation campaigns. | [help/222640851458826](https://www.facebook.com/business/help/222640851458826) |
| 15 | **Creative limited** = *"cost per result is more than ads you ran in the past but less than twice as much."* **Creative fatigue** = *"cost per result is more than or equal to twice as much as ads you ran in the past."* Both `CREATIVE_LIMITED` and `CREATIVE_FATIGUE` exist as recommendation types. | [help/1346816142327858](https://www.facebook.com/business/help/1346816142327858) + recommendations ref |
| 17 | *"You can create 2 to 7 copies."* *"We suggest using no more than 20% of your existing budget…"* Highest-volume bid strategy required. *"The test does not make any automatic changes based on the results, so they will run until you turn them off or they reach the end date of the ad set, if applicable."* Test ads keep running on the original budget. | [help/1423851372208214](https://www.facebook.com/business/help/1423851372208214) |

### CONFIRMED with a correction applied

| # | What was wrong | Correction |
|---|---|---|
| 1 | Error 2703's message was **truncated**. | Full verbatim is *"Rules that turn off ads can't have cost conditions. You need to change the rule's conditions or action."* The substance — cost-condition pause rules are blocked natively, and an external `POST /{ad_id}` `status=PAUSED` is not — stands, and remains the load-bearing architectural fact. §1.8 fixed. |
| 14 | *"44+ recommendation types"* was **inflated**. | The live page publishes **37** types. 14 are applyable (that half was correct, and every `extra_data` shape in the table matched, including `BACKGROUND_GENERATION`'s required `action_type` + `object_selection` and `SCALE_GOOD_CAMPAIGN`'s `adsets`/`campaigns`). §0 and §10 fixed. |
| 16 | Split testing is **alive and undeprecated — that part is right.** Create params, the 8-value `type` enum, `confidence_level` (float), `creative_test_config`, and the limits (*"Max concurrent studies per advertiser: 100, Max cells per study: 150, Max ad entities per cell: 100"*) all verified, no deprecation notice on either page. | But **`SPLIT_TEST_V2` is not in the `AdStudy` reference's `type` enum** — only the guide names it. And "renders at v26.0" was wrong: the `AdStudy` and Opportunity Score pages render examples at **v25.0**. That is stale doc boilerplate, not deprecation (v26.0 confirmed current), but it is not evidence of currency either. §7.1 fixed. |

### REFUTED

| # | Claim | Verdict |
|---|---|---|
| 3c | *"rules implicitly add an `effective_status` filter… defaults to `IN` with values `['ACTIVE','PENDING_REVIEW']` — which is why UNPAUSE rules silently do nothing."* | **REFUTED.** The real verbatim is *"By default, if you do not specify an `effective_status` filter, we implicitly add an `effective_status` filter when evaluating the rule"*, and the page documents **two** defaults: `IN ['ACTIVE','PENDING_REVIEW']` for execution types acting on active objects, and **`NOT_IN ['DELETED','ARCHIVED']` for types that do not act on active objects — naming `UNPAUSE` explicitly** as *"an internal optimization for our execution types."* So `UNPAUSE` rules **do** see paused objects and the "classic bug" described did not exist. The inverted risk (an `UNPAUSE` rule reactivating something the optimizer deliberately paused) is real and now documented in §1.2 and gotcha #4. |
| 5b | *"trigger rules can only PAUSE/UNPAUSE/NOTIFICATION/PING_ENDPOINT."* | **`UNPAUSE` is unsupported by the source.** The trigger guide has no enumeration of permitted execution types at all and demonstrates only `PING_ENDPOINT`, `NOTIFICATION`, `PAUSE`; `UNPAUSE` appears nowhere on the page. Downgraded to UNVERIFIED in §1.3. Everything else in claim 5 confirmed. |

### UNCERTAIN — could not verify

| # | Claim | Status |
|---|---|---|
| 18 | Meta *"will run that ad more frequently"* / *"putting each ad in its own ad set"*. | **The cited URL `facebook.com/business/help/464145940405064` is a hard 404.** Neither quoted string could be located in any live Meta page; both are now marked UNVERIFIED in §5.1. **The underlying mechanism is confirmed** from "About the ad auction" (https://www.facebook.com/business/help/430291176997542): the winner is *"the ad with the highest total value"* from bid × estimated action rates × ad quality, and *"an ad that's more relevant to a person could win an auction against ads with higher bids."* The *"delivery system learns less about each ad and ad set"* half is confirmed at [help/112167992830700](https://www.facebook.com/business/help/112167992830700), as is "too many ads" causing Learning limited. **The engineering conclusion — intra-ad-set impression share is an auction outcome, so ad-level CPA in a shared ad set is an exploitation signal, not a causal read — survives intact and is the only part that matters.** Do not re-cite the dead URL. |

### Still UNVERIFIED from the original draft (unchanged by this pass)
Advanced-filter aggregation/formula syntax; `rebalance_spec` key names and whether `PROPORTIONAL` is a literal enum; `/{rule_id}/preview` and `/execute` paths; `execution_options` shapes for the 10 undocumented `execution_type` values; `creative_test_config` keys; the `confidence_level` default; recurring `budget_schedules`; the ad-set-budget-sharing API field name; `frequency_control_specs` compatibility on AUCTION conversion goals; whether Auction Overlap Rate is exposed in the Insights API; whether the 2016 `validate_only` + `include_recommendations` contract holds at v26.0.

### Added by this pass (missing from the original draft)
1. **Error 80004 on `adrules_library`** — *"There have been too many calls to this ad-account. Wait a bit and try again."* Rule provisioning is itself per-account rate-limited. (§1.8, gotcha #21)
2. **`type` vs `recommendation_name` availability split** in the Recommendations API — `type` is ad-account-requests only, `recommendation_name` is business-level-requests only. A portfolio-wide collector keying its whitelist off `type` matches nothing. (§10, gotcha #22)
3. **`SPLIT_TEST_V2` is absent from the `AdStudy` reference `type` enum**, contradicting the split-testing guide. (§7.1, gotcha #23)
4. **`adset_schedule` verbatim constraint** — *"start_minute and end_minute must be on the hour and must be at least one hour apart"*, 4 hours for Reach & Frequency, and *"Only use ad scheduling with lifetime budgets."* Confirms §2.5.
5. **`learning_stage_info.status = FAIL` verbatim gloss** — *"The ad set isn't generating enough results to exit the learning phase."* (gotcha #20)
