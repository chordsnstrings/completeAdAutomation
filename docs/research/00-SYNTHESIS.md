# 00 — SYNTHESIS

**The single document to read before writing code.**

Compiled 2026-09-02. Baseline: Graph API **v26.0** and Marketing API **v26.0**, both released 2026-07-29.

This consolidates twelve research dossiers (~17,200 lines) in `docs/research/` into one adjudicated
reference. Where the dossiers disagree with each other, this document **picks a side and says why**
(§12 carries the full adjudication log). Where nothing is verified, it says **UNVERIFIED** and marks
who has to go find out.

**Confidence tags used throughout**
`[OFFICIAL]` quoted from a Meta/Google/BytePlus primary source · `[SDK]` from `facebook-python-business-sdk`
v26.0.1 codegen, which is generated from Meta's internal spec and is *more* reliable than the HTML docs
for field names and enums · `[MEASURED]` executed in the research environment · `[SECONDARY]` a
practitioner or press source · `[INFERRED]` reasoned but not stated · `[UNVERIFIED]` needs a live probe
before you build on it.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Possible vs gated vs impossible](#2-possible-vs-gated-vs-impossible)
3. [The end-to-end reference flow](#3-the-end-to-end-reference-flow)
4. [Minimum viable user input](#4-minimum-viable-user-input)
5. [Provider decision: Veo vs Seedance vs both](#5-provider-decision-veo-vs-seedance-vs-both)
6. [The autonomy engine](#6-the-autonomy-engine)
7. [Competitive positioning](#7-competitive-positioning)
8. [Cost model](#8-cost-model)
9. [Risk register](#9-risk-register)
10. [Recommended architecture and phased build plan](#10-recommended-architecture-and-phased-build-plan)
11. [Open questions the human must answer](#11-open-questions-the-human-must-answer)
12. [Adjudication log — where the research contradicted itself](#12-adjudication-log)
13. [The empirical probe list — week one](#13-the-empirical-probe-list--week-one)

---

## 1. Executive summary

### 1.1 Can this be built?

**Yes. The technical path is fully mapped and there is no missing primitive.** Every stage —
generate video, upload it, construct a compliant campaign tree, publish it, read performance back,
decide, regenerate — has a documented API and a known failure mode. Nothing in the research turned up
a wall that stops the machine from being built.

What the research *did* turn up is that **the hard part is not the loop, it is everything the loop
depends on that Meta refuses to expose.** You cannot attach a payment method by API. You cannot verify
a domain by API. You cannot accept the Custom Audience terms, the non-discrimination certification, or
(probably) the Lead Ads terms by API. You cannot appeal a disapproval by API. You cannot get a
Conversion Lift study without a Meta rep. Each of those is a human, UI-bound, sometimes multi-day gate,
and they cluster at exactly one point in the product: **onboarding**.

So the honest product shape is not "three inputs and it runs." It is:

> **A one-time assisted setup that takes days and requires the client's credit card, DNS access,
> Business Manager admin, and a signed agreement — after which the system runs unattended between
> weekly checkpoints, with a bounded escalation queue.**

That is still a genuinely new product. Nobody sells it (§7).

### 1.2 How far can autonomy really go?

Split the decisions into three classes.

**Class A — fully unattended, defensible today.**
Creative generation and variant selection. Publishing (create-PAUSED → verify → activate). Budget
moves *inside a human-approved envelope*. Pausing. Scaling inside the envelope. Creative retirement and
fatigue response. Routine policy remediation, capped at two attempts per creative lineage. Placement,
targeting and bidding — because you delegate all three to Meta and it is better at them than you by
several orders of magnitude.

**Class B — unattended with a hard bound, escalating on breach.**
Anything that touches money above the envelope. Anything the disapproval loop cannot fix in two tries.
Anything where `disable_reason` becomes non-zero. Anything where `effective_authorization_category`
comes back `POLITICAL` when you set `NONE`.

**Class C — permanently human, no API exists.**
Funding. Domain verification. AEM 8-event configuration. Custom Audience ToS. Non-discrimination
certification. SIEP authorization. Business Verification. Appeals and restriction reviews. Approval of
the *offer* and of any substantiable *claim*. Increasing the spend envelope.

**The ceiling, stated numerically and honestly:** the system can own roughly **95% of recurring
operating decisions and 0% of the gates**. Steady-state escalation volume should target **under one
human-touch item per account per month**; if it runs above that, the product is a worse agency, not a
better one. A "fully autonomous, zero human" claim is false and will be falsified in month one by a
declined credit card.

### 1.3 The five findings that should change how you build

1. **An ad account with no funding source returns HTTP 200 on every write and delivers nothing.**
   `[OFFICIAL]` — *"If the account does not have a payment method it will still be possible to create
   ads but these ads will get no delivery."* An optimiser reading zero impressions will conclude the
   creative failed and regenerate. It will spend real money on video generation to fix a billing
   problem. **The account-health preflight is the highest-value ten lines of code in the system.**

2. **Age-confounded early killing is the most expensive algorithmic bug available.** A 2-day-old ad has
   ~55% of its conversions reported; a 7-day-old ad ~95%. Compare them naively and you systematically
   kill exactly the creative your generator just made. The symptom looks like "the AI rejects its own
   work." The fix — `s_effective = spend × F(age)` inside the posterior — is small, and finding it in
   production is not.

3. **The statistics settle the product tiering, not the marketing.** ~470 conversions per arm to detect
   a 20% CPA difference two-sided at 80% power; ~100 for a one-sided Bayesian rule at 90%. At a $40 CPA
   that is $18,800/arm versus $4,000/arm. **Below roughly $2k/week of account budget, formal creative
   testing is arithmetically impossible, not merely hard.** Publish the tiers rather than promising
   uniform "AI optimisation."

4. **Meta gives away the thing most competitors sell.** `mcp.facebook.com/ads` (write tools),
   `pip install meta-ads` (official CLI, first released 2026-04-29), the Ad Rules Engine,
   `opportunity_score`, a typed `/recommendations` read-and-apply API, and `creative_fatigue` webhooks
   — all free, all first-party. Any moat built on "we wrap the Marketing API for an agent" expired in
   April 2026. What Meta structurally cannot do: originate video from your product's physical truth,
   reason about your *angle* and your *offer*, control your landing page, or optimise your contribution
   margin instead of its own revenue.

5. **The liability chain reaches the tool, and Meta's own liability is capped at $100.** Self-Serve Ad
   Terms `[OFFICIAL]`: *"If the advertiser you represent violates these Self-Serve Ad Terms … we may
   hold you responsible for that violation."* Commercial Terms `[OFFICIAL]`: aggregate liability
   *"will not exceed the greater of one hundred dollars ($100)."* If your loop overspends a client by
   $9,000 — entirely possible given the 175%-of-daily-high-water-mark pacing ceiling — that money is
   allocated between you and the client by your contract alone. Write it before the first customer.

### 1.4 What to build first

Get one real ad live on a real funded account you own, in the first two weeks, on **Path A**
(you own the Business portfolio, the app and the ad account — Standard Access alone is legally
sufficient, no App Review). This simultaneously starts the 500-calls-in-15-days clock for the Full
access tier and settles the one genuinely unverified load-bearing fact in the whole corpus (§13).
Run Business Verification and the `ads_management` + `leads_retrieval` App Review in parallel, because
they are calendar time you cannot compress.

---

## 2. Possible vs gated vs impossible

This section exists so that nobody plans around a capability that does not exist. Read all of it
before writing a roadmap.

### 2.1 Access: the two dials Meta named identically

Meta reused the words *Standard* and *Advanced* for two independent things. Tape this to the wall.

**Dial 1 — permission access level** (per permission, set by App Review):
- *Standard Access* — the permission works only for users with **a role on the app, or a role in a
  Business that has claimed the app**. Auto-granted, no review. `[OFFICIAL]`
- *Advanced Access* — works for **any** user. Requires **Business Verification** plus, for
  `ads_management`, an App Review submission **with a screencast**.

**Dial 2 — "Marketing API Access Tier"** (per app; controls rate-limit and system-user quota only).
Renamed 2026-05-04 from "Ads Management Standard Access". `[OFFICIAL]`

```
Dashboard label (old)      Dashboard label (new)   ads_api_access_tier header   Max point score
"Standard Access" (AMSA)   "Limited Access"        development_access           60
"Advanced Access" (AMSA)   "Full Access"           standard_access              9000
```

The header values are *believed* unchanged post-rename because the announcement says "no code changes
are required" — **UNVERIFIED** whether Meta now emits `limited_access`/`full_access`. **Parse
defensively; treat any unknown string as the low tier.**

Qualifying for Full Access (effective 2026-05-04, lowered from 1,500 calls): **500+ Marketing API calls
in the trailing 15 days** and **<15% error rate over the last 500 calls**, then click "+Upgrade".
**The screencast was dropped for this tier upgrade but is still required for the `ads_management`
App Review.** Conflating the two wastes a review cycle.

### 2.2 The two viable access paths

| | **Path A — own everything** | **Path B — multi-tenant SaaS** |
|---|---|---|
| Structure | Your Business portfolio owns the app *and* the ad accounts | Client businesses grant assets via Facebook Login for Business |
| Token | System User token (never expires) | Business Integration System User (BISU) token (defaults to never expire) |
| Gate | **None.** Standard Access is legally sufficient | **Business Verification + App Review** for Advanced Access on `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `leads_retrieval` |
| Calendar cost | Same day | **6–10 weeks**, and it is a chicken-and-egg: you need ≥1 successful call per permission in the 30 days before submitting |
| API surface | **Identical** | **Identical** |

**Design consequence — this is the single most important sequencing decision in the build.** Isolate
token acquisition behind one `TokenProvider` interface with two implementations
(`SystemUserTokenProvider`, `BisuTokenProvider`). Build and validate the entire product on Path A while
the Path B paperwork runs in parallel. Nothing else differs.

**Path B gotchas that will bite:**
- Login for Business is **all-or-nothing**: if the client declines any permission in the configuration,
  you receive *none* of them. Keep configurations minimal; create separate configurations for optional
  capabilities (catalog, leads).
- Mint **granular per-client tokens** via `POST /{CLIENT_BUSINESS_ID}/system_user_access_tokens` rather
  than reusing the original — a compromise is then contained to one tenant. `appsecret_proof` is
  mandatory on this endpoint regardless of the Require-App-Secret toggle.
- Clients can revoke BISU tokens from **Business Settings → Integrations → Connected apps** with **no
  webhook**. You will discover it as a `#190` at 3am. Poll `debug_token` weekly.
- `granular_scopes[].target_ids` from `debug_token` is the most useful field in the whole auth surface:
  it tells you *which specific ad accounts and Pages* the user actually ticked. Users routinely grant
  `ads_management` and deselect the account you need — the token looks perfect and every write returns
  `#200`. Store it at onboarding, re-check on every `#200`/`#294`.
- **Use-it-or-lose-it.** Developer Policy 10.4 `[OFFICIAL]`: *"Standard and Advanced Ads API access may
  be downgraded to Development access after 30 days of non-use."* Ship a weekly heartbeat job, forever,
  on every app including staging.
- **Data Access Renewal / Data Use Checkup** — 60-day window from notification; miss it and the app is
  disabled and every client write fails at once. This is a product risk with a named human owner, not
  an ops chore.

### 2.3 What is genuinely impossible or human-only

Nothing in this table has an API. Every one of them is an onboarding gate or an incident.

| Gate | Why it blocks | Evidence |
|---|---|---|
| **Attach a payment method to an ad account** | Without `funding_source`, every write succeeds and nothing delivers | `[OFFICIAL]` AdAccount ref; `POST /{business_id}/adaccount` takes `funding_id` that must *already exist* |
| **Verify a domain (DNS TXT / HTML file)** | Required for conversion optimisation and AEM; claimable by exactly one business | `[OFFICIAL]` domain-verification doc lists no endpoint |
| **Configure the 8 AEM conversion events** | Events Manager UI only | `[OFFICIAL]` |
| **Accept Custom Audience ToS** | `code 200, subcode 1870090` until a human clicks, **per business** | `[OFFICIAL]` |
| **Non-discrimination certification** | Error `2859024` "Certification Required" blocks every Housing/Employment/Credit ad; **no API call clears it** | `[OFFICIAL]` |
| **SIEP advertiser authorization** | ID upload + mailed address code; multi-day | `[OFFICIAL]` |
| **Business Verification** | Without it, Advanced Access features are inactive for other businesses' users | `[OFFICIAL]` |
| **Appeal a disapproval or an account restriction** | The `Ad` node has exactly eight edges and none is an appeal: `/adcreatives`, `/adlabels`, `/adrules_governed`, `/copies`, `/insights`, `/leads`, `/previews`, `/targetingsentencelines` | `[SDK]` verified negative |
| **Conversion Lift / incrementality studies** | *"currently limited. Please contact your Meta Representative."* | `[OFFICIAL]` |
| **Opt in to `impression_device` / `frequency_value` / audience-timezone hourly breakdowns** | Since 2026-08-06 non-sales-supported accounts need an Ads Manager admin opt-in. **Requests return NO RESULTS, not an error.** | `[OFFICIAL]` |
| **Accept Lead Ads ToS on the Page** | Source unreachable this session; treat as a blocking gate | `[UNVERIFIED]` |
| **Migrate an ASC campaign using `existing_customer_budget_percentage`** | Ads Manager only; gets paused at v26.0 | `[OFFICIAL]` |
| **Create Advantage+ Shopping / App campaigns** | `smart_promotion_type` creation, duplication and update blocked on **all versions** since 2026-05-19 | `[OFFICIAL]` |

Two more that are *technically* possible and practically not:
- **Creating ad accounts via `POST /{business_id}/adaccount`** works, but is realistically limited to
  invoiced Marketing API partners billing to a Meta credit line, and hits undocumented cap `#3979`.
- **Ad-account-level agency access** via `owned_ad_accounts` / `assigned_users` works, but **max 25 ad
  accounts per person and 25 people per ad account** `[OFFICIAL]` — so never assign a *human* user per
  tenant; you cap at 25 clients. Use system users.

### 2.4 Rate limits — the constraint that actually shapes the architecture

There are **three independent limiters plus a QPS ceiling**, and only two of them appear in headers.

**(a) Business Use Case (BUC), per business object, rolling 1 hour** `[OFFICIAL]`:

| Bucket | Limited tier | Full tier |
|---|---|---|
| `ads_management` | `300 + 40 × active_ads` | `100,000 + 40 × active_ads` |
| `ads_insights` | `600 + 400 × active_ads − 0.001 × user_errors` | `190,000 + 400 × active_ads − 0.001 × user_errors` |
| `custom_audience` | `5,000 + 40 × active_CAs` | `190,000 + 40 × active_CAs` (both capped 700,000) |
| `catalog_management` | `20,000 + 20,000 × log2(unique users)` | — |
| **`catalog_batch`** | **`200 + 200 × log2(unique users)`** | — |

Two consequences fall straight out. **Quota scales with `active_ads`, so a brand-new tenant with zero
active ads is the tightest window you will ever operate in.** And **your own 4xx rate reduces your
insights quota** (`− 0.001 × user_errors`) — a buggy retry loop does not just waste calls, it shrinks
the budget for everyone on the app.

**(b) The per-ad-account point score** — separate from BUC, invisible in headers. Read = 1 point,
write = 3 points. Limited tier max **60**, decay 300s, block 300s. Full tier max **9,000**, block 60s.
**Do the arithmetic: on Limited tier that is 20 writes per 5-minute window per ad account — four writes
a minute.** This, not the BUC hourly number, is what stops your bulk creative launcher in development.

**(c) The app-level Platform pool** — `200 × daily active users` per hour, **shared across all
tenants**. `X-App-Usage` reports `call_count`, `total_time`, `total_cputime` as percentages 0–100, and
`total_cputime` is the one that bites: you can be at `call_count: 12` and `total_cputime: 98` on a
breakdown-heavy insights query. **One tenant's backfill throttles everyone.** Give each traffic class a
fixed share of the app budget and enforce it client-side.

**(d) A separate 100 QPS mutation ceiling** per (app, ad account) on create/edit of campaigns/ad
sets/ads, surfacing only as `613` subcode `5044001`. Needs its own token bucket. `[OFFICIAL]`

**Header units, and the classic outage:** `estimated_time_to_regain_access` is in **MINUTES**;
`reset_time_duration` is in **SECONDS**; every other number is a **PERCENT**. Mixing them gives you
either a 100× too-long sleep or a hot loop.

**On batch requests the rate-limit headers live on each sub-response**, in a per-record `headers`
array — not on the outer HTTP response. A batch-heavy client reading only outer headers is blind.

**Governor thresholds worth copying verbatim** (Airbyte's production connector): back off at
`usage ≥ 85` for `max(2 min, pause)`, and at `usage ≥ 95` for `max(10 min, pause)`, where `usage` is
the max across every header field and `pause` is the max `estimated_time_to_regain_access`.

### 2.5 Hard per-object policy limits (not rate limits — policy)

| Limit | Value | Error |
|---|---|---|
| **Ad set budget changes** | **4 per hour** | `613 / 1487632` |
| **Ad account spend limit changes** | **10 per day** | `17 / 1885172` (different code family — branch on both) |
| Campaigns / ad sets / ads per **regular** ad account | **6,000 each** non-archived non-deleted | `1487809` |
| Campaigns / ad sets per **bulk** ad account | 10,000 | |
| Ads per bulk ad account | 50,000 | |
| **Archived objects** | **100,000 per type — a separate bucket** | |
| Ads per ad set | 50 | |
| Dynamic Creative ads per account | 1,000 | |
| High-demand budget periods | 50 per object, ≥3h each, ≤8× daily budget | |
| Native automated rules | 250 per account | |
| Batch operations | 50 per request, each counting individually | |
| `/copies` deep_copy children | 3 synchronous, 51 asynchronous | |
| `asset_feed_spec` assets | 30 total (≤10 video, ≤10 image, ≤5 each text field) | |
| Ad accounts per person / people per ad account | 25 / 25 | |

**The 6,000-vs-100,000 split is the most useful line in this table.** Archived objects live in a
separate bucket, so **archiving is the correct garbage-collection primitive** — it frees live headroom
without destroying history. A generative pipeline that spawns an ad set per creative will hit 6,000 ad
sets long before it hits 6,000 ads. Ship the archival job on day one, and snapshot stats to the
warehouse before transitioning, because `DELETED` is a one-way move from `ARCHIVED` and deleted ads
keep accruing metrics for 28 days.

**Also note:** *"Ad creation is limited for a given ad account based on the daily spend limit"*
`[OFFICIAL]`, error `613 / 1487225`, remedy *"increase the daily spend limit"* — but Meta **publishes
no spend→ad-count tier table**. `[UNVERIFIED]` A low-spend new account can be rate-limited out of
creative volume regardless of your architecture. Read `GET /act_{id}/ads_volume` for the real number
in `limit_on_ads_running_or_in_review`, and watch `future_limit_activation_date`.

### 2.6 Measurement: what is permanently gone

Three attribution changes dominate, and every pre-2025 mental model is wrong.

1. **Since 2025-06-10, `use_unified_attribution_setting` and `action_report_time` are silently
   ignored.** The API always uses the ad set's own attribution setting with `mixed` reporting time:
   **spend is impression-dated while web conversions are conversion-dated in the same row.** A daily
   ROAS row is therefore *not a cohort*. True spend-date cohort ROAS is unobtainable from Insights and
   must be reconstructed from your own CAPI-side data.
2. **Since 2026-01-12, `7d_view` and `28d_view` return no data.** They still parse; they return zeros,
   not errors. Reported conversions dropped 15–40% for view-heavy accounts. **Any model or benchmark
   trained on pre-2026 view-through data is invalid.**
3. **From March 2026, "engage-through" (`1d_ev`) absorbed non-link clicks** and click-through narrowed
   to link clicks only.

Plus the structural ones:
- **Insights rows stay mutable for 28 days.** *"Insights refresh every 15 minutes and do not change
  after 28 days."* The warehouse must upsert a **rolling 28-day window**, keyed on
  `(date_start, level, object_id, breakdown_hash, attribution_setting, observed_at)`. A 7-day refetch
  permanently under-reports. **Never upsert a `(ad_id, date)` primary key** — you destroy the answer to
  "what did we believe when we made that decision," which is the only question an autonomous system
  must be auditable on.
- **37-month hard lookback.** Anything older is unrecoverable; archive `raw` yourself.
- **Asset-level breakdowns will only ever return impressions, clicks, spend, reach, actions and
  action_values** — no ROAS, no video retention, no ranking diagnostics, ever — and are confounded by
  Meta's own asset selection. **Therefore: one creative = one ad. `level=ad` is the only clean creative
  read.** This single fact rules out Dynamic Creative and Flexible Ad Format for the generated-video
  pipeline.
- **Sandbox has no Insights at all** and is invisible in Ads Manager. **The optimisation loop cannot be
  developed or tested in sandbox.** One sandbox account per app, regardless of tier.

### 2.7 Statistical floors — the arithmetic that sets product scope

`Var(log RR) ≈ 2/E` for `E` conversions per arm, so MDE `= exp(z·sqrt(2/E))`.

| Conversions/arm | MDE, 80% power, two-sided α=0.05 | One-sided Bayesian at P≥0.90 | Spend/arm @ $40 CPA |
|---|---|---|---|
| 25 | +121% | +44% | $1,000 |
| **50** (Meta's learning threshold) | **+75%** | +29% | $2,000 |
| 100 | +49% | **+20%** | $4,000 |
| 200 | +32% | +14% | $8,000 |
| **470** | **+20%** | +9% | $18,800 |
| 1,000 | +13% | +6% | $40,000 |

**Read the two right-hand columns together; they are the product strategy.** Meta's own 50-event
learning threshold is 10× too small for a defensible two-sided test — which is not a coincidence,
because 50 events is what *Meta's* optimiser needs to stabilise, not what *your* comparison needs.

The honest sentence to put in the product: *"We stop ads that are probably much worse and scale ads
that are probably better. We cannot tell you which of two similar ads is better, and neither can anyone
else at your budget."*

### 2.8 The blunt list — things that break a naive plan

- There are **no idempotency keys anywhere in the Marketing API**. Error `506` ("duplicate post") is a
  content heuristic on Page posts, not a guarantee. Any retried `POST /campaigns|/adsets|/ads|
  /adcreatives` can create a duplicate object that spends real money.
- **Meta object ids exceed 2^53.** `JSON.parse('{"id": 23851234567890123}')` loses precision
  **silently** in JS. Store as `text`, parse with a bigint-aware parser.
- **Video upload goes to `https://graph-video.facebook.com`**, not `graph.facebook.com`. Meta — not you
  — dictates each chunk's `[start_offset, end_offset)`; the loop ends when they become equal; **on
  error the resume offsets come back inside `body.error.error_data.start_offset`**; and there is **no
  offset-query endpoint** on `/advideos`, so you must persist `upload_session_id` + offset before every
  chunk or a worker restart forces a full re-upload.
- **A creative built on a video still in `video_status: "processing"` produces a broken ad.** The
  Python SDK's built-in wait gives up at 180 seconds with a generic error. Own the poll.
- **`effective_status: IN_PROCESS`** means the object exists but is not materialised. Treating it as
  failure causes double-creates. **`PENDING_BILLING_INFO`** is a silent stall with no error anywhere.
- **`ARCHIVED`/`DELETED` objects vanish from default list queries but still exist.** Reconciling without
  `effective_status` filters makes you "discover" your own objects missing and recreate them.
- **Delivery Estimate's `daily_outcomes_curve`, `budget_guardrail` and `estimate_dau` were removed with
  no replacement.** You must build your own budget-response model. (The dossiers give two dates for
  this — v26.0 removal, and a 2026-10-27 removal date. Either way: build it. §12.)
- **Budgets are in the ad account's minor units, and eleven currencies have offset 1** — CLP, COP,
  **CRC**, HUF, IDR, ISK, JPY, KRW, PYG, TWD, VND. `daily_budget: 5000` is $50.00 in USD and ¥5,000 in
  JPY. **Read `currency` off the account and look the offset up; never hard-code either constant.**
  Insights `spend`, confusingly, comes back in **major** units as a string (`"spend": "5339.5"`).
  Write cents, read dollars.
- **Insights `stat_date` is in the ad account's timezone**, not UTC. Cross-account comparison without
  normalising is a subtle permanent error.
- **`special_ad_categories` is required on every campaign create.** Send `[]` or `["NONE"]`. Omitting
  it is a hard `#100`.
- **EU-targeted ad sets require BOTH `dsa_payor` and `dsa_beneficiary`**, and **neither is flagged
  `[required]` in the parameter table** — the requirement is prose only, so a schema-driven client
  omits them silently and fails at publish.
- **`instagram_actor_id` and `instagram_story_id` exist in no supported version** (gone after
  2025-09-09). Half the tutorials and SDK samples are dead. Use `instagram_user_id` /
  `source_instagram_media_id`.
- **`npm i facebook-nodejs-business-sdk` gives you v24.0 in September 2026.** `dist-tags.latest` is
  24.0.1 (published 2025-11-21) while the repo is on 26.0.1 — the publish pipeline has been broken for
  ~9.5 months. Your calls silently go to a 10-month-old API version.
- **Veo cannot generate 4:5 or 1:1 video.** No video model in the live catalogue does. Meta's
  recommended Feed ratio therefore requires an ffmpeg reframing stage, always.
- **Meta's advertiser-facing creative guidance is not machine-readable.** `facebook.com/business/help/*`
  and `transparency.meta.com/*` are client-rendered React; `curl` gets HTTP 400 with body `Error`.
  You cannot programmatically ingest Meta's creative specs; pin them and re-verify by hand.

---

## 3. The end-to-end reference flow

From user input to a live ad to a learned improvement. Every step names the exact call and the way it
fails. Steps 0–3 are one-time per advertiser; 4–14 run per creative; 15–20 run on a schedule.

### Phase 0 — Onboarding (human-gated, days)

**Step 0. Gate state machine.** Model onboarding as an explicit state machine with per-gate status
read back from the API, exposed to the customer as a checklist. This is a product surface, not a
support process.

| Gate | Probe | Blocking? |
|---|---|---|
| Ad account exists and is ACTIVE | `GET /act_{id}?fields=account_status,disable_reason` | **Yes** |
| Funding source attached | same call, `funding_source` non-null | **Yes** |
| Page identity available | `GET /me/accounts` or granted assets | **Yes** |
| Our app has the assets | `GET /debug_token` → `granular_scopes[].target_ids` | **Yes** |
| Instagram identity | `GET /{page_id}/page_backed_instagram_accounts`, create if empty | No — degrades |
| Domain verified | client-side check | Only for website conversions |
| Pixel/dataset + AEM 8 events | `GET /{pixel_id}` + human confirmation | Only for website conversions |
| Custom Audience ToS | cheap probe for `200/1870090` | Only for audiences |
| Non-discrimination cert | probe for `2859024` | Only for Housing/Employment/Credit |

**Ship degraded modes.** With only a Page and a funded ad account you can run **lead-gen (Instant
Forms, `destination_type: ON_AD`) and click-to-message today** — no website, no domain verification,
no pixel, no AEM. That is the fastest path to a genuinely autonomous first customer, and no dossier
originally proposed it.

**Fails as:** client never adds the card (the modal churn point); DNS access sits with an agency the
client no longer uses; `granular_scopes` shows they granted `ads_management` but deselected the
account.

**Step 1. Brand ingest — four sources, before generating anything.**
1. The client's **website** — offers, proof, objections, tone, product imagery.
2. The client's **own ad account history** — past `/adcreatives` and settled insights. This is the
   highest-value cold-start asset and it is immutable data outside the 28-day window.
3. The **Page's organic posts** — free engagement priors.
4. The **Ad Library** (`GET /ads_archive`) for the category. **Critical caveat:** for ordinary
   commercial ads there is **no spend or impression data** — those fields exist only for political/issue
   ads. The only performance proxy is **longevity** (`ad_delivery_start_time` → `ad_delivery_stop_time`).
   A competitor's ad still running after 90 days is the closest thing to a free win signal. Ad Library
   API access itself is `[UNVERIFIED]` — historically needs identity + location verification.

**Step 2. Two distinct cold starts, which the dossiers conflate.**
*Brand* cold start is solved by ingestion. *Account* cold start is a **pixel-history** problem: a
brand-new dataset has no conversion history, so `OUTCOME_SALES` + `PURCHASE` sits in Learning Limited
indefinitely at SMB budgets. **The correct opening move is a cheaper optimisation event** —
`LANDING_PAGE_VIEWS` or an upper-funnel custom event — with a planned step-down to `PURCHASE` once the
weekly event count clears the ad set's own `dynamic_lp_conversions_threshold`.

**Step 3. Account preflight, cached.**
```
GET /act_{id}?fields=account_status,disable_reason,currency,timezone_id,funding_source,
                     funding_source_details,is_prepay_account,balance,amount_spent,spend_cap,
                     min_daily_budget,capabilities,business,default_dsa_beneficiary,default_dsa_payor
GET /act_{id}/minimum_budgets
GET /act_{id}/ads_volume
```
Cache currency offset, timezone, minimum budgets and the ad-volume ceiling per account.
**Abort every publish if `account_status != 1` or `funding_source` is absent.**

### Phase 1 — Creative production (per concept, ~5–7 minutes wall clock)

**Step 4. Brief → angles.** LLM emits an `AngleSet[]`. Embed the angles and **reject pairs with cosine
> 0.9** — the dominant failure is angle collapse, where the model returns five rephrasings of one idea.

**Step 5. Angle → script.** Hard constraints in the prompt, not as post-hoc checks: copy to the
**cross-placement minimum** (~40 chars primary text, ~27 chars headline), VO length estimated at
~2.6 words/s against the shot budget, AI-tell blocklist, 20-word sentence cap, Flesch-Kincaid ≤ 8th
grade. **Non-negotiable product rule:** a synthetic on-screen person is a **presenter/narrator, never a
customer recounting a personal result** — that is FTC 16 CFR Part 465 exposure (civil penalties, AI
mass-generation explicitly in scope), and Meta approving the ad is not a defence.

**Step 6. Script → ShotList (the IR).** **The ShotList JSON, not the mp4, is the product.** Everything
below this line is a pure function of it plus provider responses. Content-address it and version it.
Per-shot caching is what makes a new-hook variant cost ~$1.05 against ~$2.95 for a full ad, and a new
aspect ratio cost ~$0.

**Design shot 1 to always be the hook and always independently swappable** — no cross-shot conditioning
into it, no last-frame chaining out of it.

**Step 7. Keyframe per shot.** `gemini-3-pro-image` (Nano Banana Pro) or `recraft_v4_1` (explicit hex
palette + background colour — the cleanest primitive for enforcing a brand kit deterministically rather
than by prompt-begging). Cost $0.014–$0.24.

**Step 8. The keyframe gate — the highest-ROI check in the pipeline.** VLM + OCR + ΔE colour check
**before paying for motion**. A keyframe costs $0.014–$0.24 and is inspectable in ~1s; the clip it
seeds costs $0.80–$3.20. **Rejecting a wrong logo at the keyframe costs ~3% of rejecting it at the
clip.** Route by failure type: OCR failure → escalate model or composite; ΔE → re-prompt with explicit
hex; **extra/unlicensed logo → HARD reject, no retry** (this is the `dri_counterfeit` path).

**Product fidelity default: tier-1 compositing.** Background-remove the *real* packshot, generate the
scene **without** the product, harmonise with contact shadow + Reinhard colour transfer, overlay.
Generating a scene *with* a product and then fixing it leaves an inpainting scar and mis-lit geometry.
This matters because *"the output misrepresents the product"* is the #1 complaint across every AI
creative vendor in the market (§7).

**Step 9. Keyframe → clip.** Veo 3.1 Fast on Vertex, `storageUri` set to your own GCS bucket,
`sampleCount` up to 4. Prompt for **motion only** and refer to people as "the subject" — re-describing
what is already in the source image measurably degrades output.

**Fails as:** safety refusal (parse the numeric support code and route: celebrity `29310472`/`15236754`
→ auto-rewrite with generic descriptors; third-party IP `35561574`/`35561575` → **human queue, never
auto-retry**); `raiMediaFilteredCount > 0`; provider timeout. **Never implement a "relax the safety
filter and retry" fallback** — carve-out 2 of Google's indemnity voids coverage for any output produced
after circumventing filters.

**Step 10. Voice, music, captions.**
- VO: round-trip ASR verification (synthesise → transcribe → string-compare to script) at ~$0.0002 per
  check. **The best cost/benefit gate in the pipeline** and the only thing that catches a mangled brand
  name.
- Music: **require a licence record per asset and fail the build without one.** Rank sources by who
  bears the risk: indemnified Vertex GA > explicitly ad-cleared (ElevenLabs Music paid) > licensed
  stock > assigned-but-disclaimed (Suno) > model-native audio (worst — no licence record at all).
  **Meta Sound Collection is unusable** for any multi-channel platform: *"may not be used separately
  from the Meta Company Products."* And **licensed music blocks Instagram Reels promotion outright**;
  the only API remedy (the 2026 audio-swap flow) needs an existing `source_instagram_media_id` and
  cannot rescue a freshly rendered file.
- Captions: **libass with authored `.ass` files**, explicit `PlayResX/Y`, `MarginV = 0.35 × height`,
  `MarginL/R = 0.06 × width`. **Never `drawtext`** — it gained a hard libharfbuzz dependency between
  FFmpeg n6.0 and n6.1 and is absent from common static builds.

**Step 11. Assembly and the render matrix.** Master at **9:16 1080×1920**, derive 4:5 / 1:1 / 16:9 by
centre crop. Put *"subject within the central square (y ∈ [420,1500])"* into the keyframe prompt — that
one instruction makes both derived crops free and removes the need for saliency tracking.

**Constrain burned-in text and logos to the strict safe box** — 14% top, 35% bottom, 6% sides, i.e.
roughly a **951×980 region on a 1080×1920 canvas (25% of frame area)**. This must be a hard constraint
on generation, not a post-hoc check.

**Step 12. QA gates — three ffmpeg defaults silently produce Meta-noncompliant output.** `[MEASURED]`
1. `pad` after `scale=…force_original_aspect_ratio` yields **non-square SAR** (`2025:2024`). Always end
   geometry chains with `setsar=1`.
2. Single-pass `loudnorm` outputs **192 kHz**. Meta's ceiling is 48 kHz. Two-pass with `linear=true`,
   and always append `aresample=48000`.
3. `moov` at the end of the file without `+faststart`.

ffprobe-assert on every deliverable: `codec_name=h264`, `profile=High`, `pix_fmt=yuv420p`,
`sample_aspect_ratio=1:1`, `r_frame_rate == avg_frame_rate`, audio `aac/48000/2ch`, size well under
200 MB, moov-before-mdat. This eliminates the dominant class of Meta error `352` "Unsupported video
format" — generative models frequently emit `yuv444p` or 10-bit.

**Step 13. Emit a render manifest** carrying model ids, seeds, prompts, costs, latencies, licences and
QA results. It doubles as the **provenance ledger** you need to answer a `dri_copyright` complaint and
to find every other ad sharing a tainted asset lineage.

### Phase 2 — Publish (per ad, minutes to 48h)

**Step 14. The publish state machine — create PAUSED, verify, activate.**

```
14.0 PREFLIGHT POLICY   POST /act_{id}/ads
                        execution_options=['validate_only','synchronous_ad_review',
                                           'include_recommendations']
     → Meta's Ads Integrity validations run WITHOUT creating the ad. Free. Zero BUC cost risk.
     ⚠ synchronous_ad_review silently no-ops without validate_only.
     ⚠ it does NOT evaluate your landing page.

14.1 IDEMPOTENCY        idem = sha256(tenant|account|pipeline_version|canonical_json(spec))[:32]
                        write the intent ledger row BEFORE any network call
                        POST /act_{id}/adlabels  {"name": "idem:<key>"}

14.2 ASSETS             POST /act_{id}/advideos     (chunked, graph-video host, persist offsets)
                        poll GET /{video_id}?fields=status until status.video_status == "ready"
                          backoff 2s→5s→10s→15s, hard-fail at 15 min
                        POST /act_{id}/adimages     (poster → image_hash; cache sha256→hash PER ACCOUNT)

14.3 CAMPAIGN           POST /act_{id}/campaigns    status=PAUSED
                        name, objective=OUTCOME_*, special_ad_categories=[],
                        daily_budget AT CAMPAIGN LEVEL, bid_strategy=LOWEST_COST_WITHOUT_CAP,
                        adlabels=[{id}]

14.4 AD SET             POST /act_{id}/adsets       status=PAUSED
                        campaign_id, billing_event=IMPRESSIONS, optimization_goal, promoted_object,
                        targeting{geo_locations, targeting_automation{advantage_audience:1}},
                        NO publisher_platforms / *_positions / device_platforms,
                        attribution_spec set explicitly, dsa_payor + dsa_beneficiary if EU

14.5 CREATIVE           POST /act_{id}/adcreatives
                        object_story_spec{page_id, instagram_user_id, video_data{...}},
                        url_tags with ID macros, degrees_of_freedom_spec with exhaustive OPT_OUT

14.6 AD                 POST /act_{id}/ads          status=PAUSED
                        adset_id, creative, conversion_domain, adlabels

14.7 VERIFY             GET /{campaign_id}?fields=advantage_state_info
                          → treat advantage_state == DISABLED as a PUBLISH FAILURE, not a warning
                        GET /{creative_id}?fields=degrees_of_freedom_spec
                          → DIFF against what you sent; store the EFFECTIVE spec as the experiment record
                        GET /{ad_id}?fields=effective_status,issues_info,ad_review_feedback
                        GET /act_{id}/generatepreviews across the 7-format set, render headlessly,
                          run the vision pass

14.8 ACTIVATE           POST /{campaign_id} {status:ACTIVE}   ← the ONLY money-starting call
                        POST /{adset_id}    {status:ACTIVE}
                        POST /{ad_id}       {status:ACTIVE}
                        guarded by the spend_authority row (SELECT … FOR UPDATE)
```

**Why this shape is the highest-leverage design decision in the build:** a duplicated PAUSED tree costs
$0 and is garbage-collectable; a duplicated ACTIVE tree costs real money. **Collapsing all spend risk
into a single idempotent status flip on an object whose id you already hold** is what makes the absence
of idempotency keys survivable.

**Idempotency recovery, on any retry:**
```
1. Read intent row. CONFIRMED → return meta_object_id. Done.
2. IN_FLIGHT or attempts > 0:
     GET /act_{id}/{campaigns|adsets|ads}bylabels?ad_label_ids=[<label>]&operator=ALL
     exactly 1 result → CONFIRM, return
     >1 results       → ALARM. Double-create already happened. Keep lowest id, archive the rest, page.
     0 results        → safe to (re)issue the create
3. Mark IN_FLIGHT, attempts += 1, issue create with adlabels attached
4. Network-ambiguous failure → leave IN_FLIGHT; the retry hits step 2
```
AdLabels beat name-matching because labels are a first-class filterable edge, `name` is not a documented
filter on `GET /act_{id}/campaigns`, and labels survive the renames an autonomous system will do.

**Fails as:** account not ACTIVE or unfunded (halt, do not interpret as creative signal); illegal
`objective × optimization_goal × billing_event × destination_type` tuple returning an undifferentiated
`code 100`; `IN_PROCESS` mistaken for failure → double-create; `advantage_state: DISABLED` because one
placement field leaked in; video still `processing`; EU ad set missing `dsa_payor`; `PENDING_BILLING_INFO`.

**Step 15. Review poller.** Every 10–15 min for ads in `{PENDING_REVIEW, PREAPPROVED, ACTIVE,
WITH_ISSUES}`, reading `effective_status`, `ad_review_feedback{global,placement_specific}`,
`issues_info`, `recommendations`, `creative{effective_authorization_category}`. Backoff 1m, 2m, 5m,
15m, 30m, then hourly to 48h, with a hard timeout and an escalation path — **Meta publishes no review
SLA and there is no API to expedite**. Typical <24h, unusual >48h, worst case ~a week.

**Merge `global` and ALL `placement_specific` surfaces into one reason map.** `global` is routinely
empty while `placement_specific` is populated — "no reason given" almost always means you only read
`global`. The reason-code namespace is **undocumented** (the Ad Review Feedback Definitions doc 404s at
every version path); build your own registry by observation.

**Remediation, bounded:**
```
dri_copyright / dri_counterfeit  → halt the ENTIRE creative lineage globally, page a human. Never auto-retry.
effective_authorization_category ∈ {POLITICAL, POLITICAL_WITH_DIGITALLY_CREATED_MEDIA}
                                 → pause campaign, page. This is a free, high-value classifier signal AND an emergency.
attempts >= 2 on this lineage    → quarantine, page.
otherwise                        → feed the LLM the VERBATIM ad_review_feedback value strings (they contain
                                   "How to fix:" guidance), re-run the full pre-flight gate, and
                                   CREATE A NEW AD IN THE SAME AD SET — never edit the existing one.
                                   Editing is a significant edit and resets the ad set's learning phase.
```

### Phase 3 — Measure and learn (scheduled)

**Step 16. Insights sync — designed around ONE account-level call.**
```
GET /act_{id}/insights?level=ad&time_increment=1
    &time_range={rolling 28 days}
    &fields=spend,impressions,clicks,inline_link_click_ctr,actions,action_values,
            video_play_curve_actions,video_p25/50/75/95/100_watched_actions,
            quality_ranking,engagement_rate_ranking,conversion_rate_ranking,
            attribution_setting,creative_fatigue_summary,creative_diversity_score,
            opportunity_score_l4
    &filtering=[{field:"ad.effective_status", ...}]
```
once per hour. Plus one `publisher_platform + platform_position` call, one `age + gender` call and one
`country` call per account per day. **Everything historical goes async.** Rate limit is the
architectural constraint, not API richness.

Async flow: `POST /{object}/insights` → `report_run_id` → poll until `async_status == "Job Completed"`
**and** `async_percent_completion == 100` (100% does not imply success — `Job Failed` also reports 100).
**`Job Skipped` is a normal, retryable outcome** meaning the job expired from inactivity; resubmit.
`report_run_id` expires after 30 days.

**Step 17. Persist append-only snapshots**, partitioned monthly, with `attribution_setting` **in the
primary key** and an internal `attribution_regime` version stamped on every row so the 2026-01-12
(view windows removed) and March-2026 (engage-through) discontinuities are queryable rather than
mysterious. Keep `raw`. Build a `metric_current` materialised view for dashboards and **never let the
decision engine read a mutable table.**

**Step 18. Read the free first-party signals every sync.**
- `GET /act_{id}/recommendations` — `CREATIVE_FATIGUE` and `CREATIVE_LIMITED` are the primary trigger
  for the generation pipeline; `BUDGET_LIMITED` and `SCALE_GOOD_CAMPAIGN` are the primary scaling
  signal. **Meta sees the auction supply curve and you do not.** Apply only from an explicit whitelist;
  never persist a `recommendation_signature` across runs (they expire).
  ⚠ `type` is returned on **ad-account** requests only and `recommendation_name` on **business-level**
  requests only — a portfolio-wide collector keying its whitelist off `type` matches nothing.
- `learning_stage_info{status, conversions, last_sig_edit_ts, dynamic_lp_conversions_threshold}` on
  every ad-set sync. **`FAIL` is Meta's name for Learning Limited**, not `LEARNING_LIMITED`. The correct
  response is consolidation (fewer ad sets, more budget each) or an upper-funnel optimisation event —
  **never more creative iteration.**
- `GET /act_{id}/adrules_history?hide_no_changes=true` — treat any `PAUSED`/`CHANGED_BUDGET` action your
  loop did not initiate as an external edit. Without this, native rules and your optimiser will fight
  and the state model drifts.

**Step 19. Decide (§6).** Two loops with two freshness contracts: a **guardrail loop on fresh data**
(runaway spend, zero delivery, `effective_status ∈ {DISAPPROVED, WITH_ISSUES}`) and an **optimisation
loop on settled data**. Mixing them is how autonomous systems kill good ads on day-1 noise.

**Step 20. Learn.** Fit the hierarchical attribute model nightly; promote a claim from account scope to
vertical scope only when the credible interval excludes zero **and ≥3 distinct accounts contributed
randomised evidence**. Push the refreshed priors into the online service; the online loop does conjugate
updates only and never runs MCMC in the request path.

**Fails as:** attribution regime boundary crossed without a flag → the model learns a step change as a
creative effect; `actions[]` summed naively → double-counting from overlapping roll-ups; ad-level CPA
inside a shared ad set read as a creative effect (it is Meta's adaptive allocation, an exploitation
signal, not an evaluation signal); ad-set-level cost read under CBO (Meta deliberately distorts it — the
"bad" ad set may be cheap *because* it is starved).

---

## 4. Minimum viable user input

The product promise is "a few inputs." That promise is achievable **per campaign** and false **at
setup**. State it honestly and the product still sells; state it dishonestly and you churn in week two.

### 4.1 One-time setup — the unavoidable floor

Ordered by how often it kills the onboarding.

| # | Input | Why it is unavoidable | Can we automate? |
|---|---|---|---|
| 1 | **A funded ad account** (payment method attached) | Without `funding_source` every write returns 200 and nothing delivers. There is **no public API to add a payment method**; `POST /{business_id}/adaccount` accepts only a `funding_id` that must already exist. | **No.** Permanent human step, in onboarding *and* in recovery when a card fails mid-flight. |
| 2 | **A Facebook Page** | `object_story_spec.page_id` is required for every ad creative. No Page, no ad. | No. |
| 3 | **Asset grant to our app** | Login for Business consent (Path B) or system-user assignment (Path A). Note the ordering trap: the target must already be a business member *before* `assigned_users` succeeds, and the system user must have the app installed *before* it can mint a token. | Partially — the consent flow is a click, but only the client can click it. |
| 4 | **A signed client agreement** carrying Platform-Terms flow-downs | §5.b makes you a Tech Provider: you must *"contractually prohibit [your Client] from Processing Platform Data in a way that would violate these Terms"* and *"you are responsible for their acts and omissions."* Meta may audit on **10 business days' notice**. | No — legal artifact. |
| 5 | **Brand constraints and rights warranties** — what must never appear, logo/palette, and explicit confirmation of rights to any spokesperson likeness or voice | ElevenLabs Professional Voice Cloning is self-only (*"Even with their consent, you cannot clone someone else's voice"*). A synthetic likeness of a real person is a right-of-publicity claim plus an EU AI Act Art. 50(4) obligation. Google's indemnity **never** covers trademark claims *"as a result of Customer's use of such Generated Output in trade or commerce"* — i.e. never for advertising. | No. The warranty is the point. |
| 6 | **An Instagram account** (or accepting the PBIA penalty) | Instagram placements need `instagram_user_id`. A Page-Backed Instagram Account can be created via API, but PBIA ads render the profile handle **in black and non-clickable**. | Partially — surface the branding penalty at onboarding so they are motivated to connect a real account. |
| 7 | **Domain verification** (DNS TXT or HTML file at web root) — *website advertisers only* | No API exists. Claimable by exactly one business. Business Tools Terms forbid the obvious shortcut: *"you may not place pixels associated with your Business Manager or ad account on websites that you do not own"* — so hosting every tenant's landing page on `lp.ourplatform.com` and firing their pixel from it is a terms violation on its face. | **No.** Client CNAMEs `go.clientbrand.com` to your edge and verifies with *their* business. |
| 8 | **Pixel/dataset + the 8 AEM conversion events** — *website advertisers only* | Events Manager UI only. | **No.** |
| 9 | **Custom Audience ToS acceptance** — *only if you use audiences* | `code 200, subcode 1870090`, per business. | **No.** Pre-flight with a cheap probe rather than discovering it mid-launch. |
| 10 | **Non-discrimination certification** — *Housing/Employment/Credit only* | Error `2859024` cannot be cleared by any API call. A business admin must accept the policy in Business Manager. | **No.** Detect at onboarding, not at publish time. |

**Items 1–5 are hard-blocking for every advertiser. Items 7–10 are conditional and should each unlock a
capability rather than block first spend.** This is the argument for shipping the **on-Meta destination
path first**: Instant Forms and click-to-message need none of 7–10.

### 4.2 Per-campaign input — the actual "few inputs"

Six fields. Every one of them is either legally load-bearing or economically load-bearing, and none can
be inferred safely.

| # | Input | Why it cannot be inferred |
|---|---|---|
| 1 | **What you sell, with proof** — product URL, feed, or real photographs | Product fidelity is the #1 complaint across every AI creative vendor in the market. Generation must be grounded in verified product truth (real imagery, spec sheet, reviews, landing-page content), not in the model's imagination. This is also what makes tier-1 compositing possible. |
| 2 | **The offer, and every claim you can substantiate** | This is the legal boundary of the system. An LLM will generate "clinically proven" if you let it. Meta's Unrealistic Outcomes / Unacceptable Business Practices policies and the FTC testimonials rule both bite here, and the human is the only party who knows what is actually true. Additionally, **`offer_type` and `offer_value` are variables to OPTIMISE, not fixed inputs** — creative-centric systems consistently miss this and it has the largest performance swing of any lever. |
| 3 | **The destination** — a URL, an Instant Form spec, or a WhatsApp/Messenger surface | Meta reviews the landing page as part of the ad and enforces a match rule: *"The products and services promoted in an ad must match those promoted on the landing page."* An autonomous generator producing 40 angles a week pointed at one static homepage is systematically violating that rule and systematically wasting the clicks it buys. |
| 4 | **The budget ceiling and pacing envelope** | The only spend authority in the system. Everything the optimiser does happens inside it. Never inferred. |
| 5 | **Target CPA or ROAS** — and, if available, **contribution margin per conversion** | Sets the prior (`rate₀ = target_CPA` in the Gamma prior) and the kill threshold. The margin figure is what enables the single most defensible design choice available: sending margin as the CAPI `value` so Meta optimises *your* profit rather than *its* revenue. |
| 6 | **Geography and language** | Drives `special_ad_category_country`, DSA fields, EU AI Act in-creative disclosure obligations, minimum radius floors, and the SIEP hard block. Silently defaulting `special_ad_category_country` to the tax country produces wrong targeting restrictions and a disapproval you cannot explain. |

### 4.3 What the human approves, and what the system decides

The research implicitly assumes the approval unit is "the ad." **It should not be — approving 40 ads a
week is not autonomy.** Build an **approval object with a scope and a TTL**, not an approval queue.

| Human approves (once, or on change) | System decides (continuously) |
|---|---|
| The **offer** and any substantiable claim | Which hook / format / mechanic expresses the offer |
| The **destination** and its content | Which creative variants exist, and when to retire them |
| The **budget ceiling** and pacing envelope | Budget allocation inside the envelope |
| **Brand constraints** — never-show, never-say, which Advantage+ enhancements are opted out | Placement, targeting, bidding (all delegated to Meta) |
| **Spokesperson likeness / voice** rights | Copy variants within approved claims |
| Escalations: any policy rejection past 2 attempts, any `dri_*` hit, any budget step above N× | Pauses, scaling within envelope, creative refresh, fatigue response |

---

## 5. Provider decision: Veo vs Seedance vs both

### 5.1 Recommendation

**Primary: Google Veo 3.1 Fast on Vertex AI. Secondary: nothing, at launch. Build the abstraction
layer anyway.**

That is three separate claims; here is the reasoning for each.

### 5.2 Why Veo on Vertex wins the primary slot

**Cost, at the resolution that matters.** Veo bills **per generation** (`/ 1 count`); Seedance bills
**per pixel-frame** (`tokens = width × height × (24·duration + 1) / 1024`, verified to the digit against
a real billed generation of 49,005 tokens). At 1080p 9:16 the comparison is not close:

| Option | 1080p 9:16 clip | With audio |
|---|---|---|
| **Veo 3.1 Fast** | **$0.10** | **$0.12** |
| Veo 3.1 Lite | $0.05 | $0.08 |
| Veo 3.1 (quality) | $0.20 | $0.40 |
| Seedance 1-0-pro-fast (5s) | $0.247 | n/a (no audio) |
| Seedance 1-5-pro (5s) | $0.296 | $0.592 |
| Dreamina 2-0 (5s) | $1.901 | included |
| Dreamina 2-5 (5s) | $2.888 | included |

**Veo 3.1 Fast is ~2.5× cheaper than the cheapest Seedance model at 1080p and ~29× cheaper than
Dreamina 2.5** — and because Veo's billing is per-count, longer clips do not cost more, whereas
Seedance scales linearly with duration *and* quadratically with resolution.

**Indemnification.** Google's IP indemnity applies **only** to Vertex AI **GA** model versions on a
**paid** account. `veo-3.1-generate-001` and `veo-3.1-fast-generate-001` qualify. `veo-3.1-lite`,
every Gemini Developer API `-preview` model, and all Gemini Omni Flash models do not.
**BytePlus has no equivalent: no clause was found in the ToS assigning output ownership to the
customer, and none on generating people or third-party brands.** For a platform putting generated
creative into paid media on someone else's account, that gap is disqualifying for the primary path
until legal reviews it.

**Throughput.** Vertex gives 50 requests/min per base model per region with `sampleCount` up to 4 —
a theoretical 200 videos/minute from one project. Seedance's documented concurrency is 10 on the
Seedance 1.x line (**not 3** — see §12), 3 on Dreamina 2.x for individual accounts, and **1 at 4K**.

**Operational fit.** `predictLongRunning` + `fetchPredictOperation`, GCS output via `storageUri`, VPC-SC
and CMEK. The Gemini Developer API is unusable for this workload at any serious tier because of a
**rolling 10-minute spend cap ($10/$50/$200) that cannot be raised on demand** — Tier 3 requires $1,000
paid plus 30 days elapsed. That is a hard architectural disqualifier, not a preference.

### 5.3 What Veo costs you

- **16:9 and 9:16 only, 24 fps, 4/6/8 seconds.** No 4:5, no 1:1, no 30fps, no 15s or 30s single-shot.
  Every 24s ad is necessarily multi-shot + concat, and every Feed placement needs an ffmpeg crop.
  (This is not a Veo-specific penalty — **no video model in the live catalogue generates 4:5 natively.**)
- **us-central1 only, no global endpoint, no multi-region failover for video.** If you need more
  headroom, shard across GCP projects rather than buying small Provisioned Throughput orders — at 1–9
  GSUs the quota enforcement window is **2,000 seconds**, which is worse than pay-as-you-go for bursty
  work.
- **No batch lane, no dynamic shared quota.** Fixed 50 RPM.
- **SynthID always on, C2PA always signed**, no opt-out. Assume every delivered asset is detectably
  AI-generated. **Do not strip provenance metadata to evade a label** — that is a Meta terms violation
  and an EU AI Act Art. 50(2) violation, and the downside is account-level penalties. (Note the
  interaction: **ffmpeg strips C2PA on re-encode**, so a Veo→ffmpeg→Meta pipeline arrives with SynthID
  intact but no C2PA manifest.)
- **English prompts only.** Other languages "not evaluated."
- **Model retirement:** `veo-3.1-generate-001` states *"November 17, 2026 or later"* — roughly a
  14-month runway. **Store model IDs as configuration, never constants.**

### 5.4 Why Seedance is still worth a slot — but a narrow one

Three things Seedance does that Veo does not, ranked by value to this specific product:

1. **Seedream layer decomposition** — one static image decomposed into up to **16 alpha layers**, which
   you then recompose into headline/CTA/background variants locally at **zero marginal model cost**.
   This has no Veo or Imagen equivalent and it is arguably the highest-value feature found anywhere in
   the provider research, because most Meta performance creative is static or near-static and because
   the ~18 UI/interface-mockup formats (App, Checkout, Email, Text Message, Website, ChatGPT screens) are
   deterministic template compositing rather than video synthesis — the largest cost advantage an
   automated system has over a human shop.
2. **Video edit / extend / stitch on the 2.x line.** Regenerating *one shot inside an existing winning
   ad* is precisely the self-improvement primitive this platform needs, and Veo has no clean analogue
   (its extension path is 720p-only and requires a Veo-generated source).
3. **$0.049 480p exploration clips.** The cheapest way to generate-and-kill 50 variants anywhere.

Against that: no established output ownership, a running task **cannot be cancelled**
(`InvalidAction.RunningTaskDeletion` — DELETE works only while queued, so cost control must be
pre-submit), result URLs **expire after 24 hours / 100 downloads**, and `dreamina-seedance-2-5` requires
per-model activation in the Ark console.

### 5.5 The verdict, and the honest caveat

**Launch on Veo 3.1 Fast alone.** Add Seedream (image/layer decomposition) in phase 2 as a *static*
generator, not a video one — it is the cheapest variant mechanism found and it carries far less legal
weight than video. Add Seedance video only if a measured advantage appears.

**The caveat that could invert every table above:** none of the research measured **effective** cost per
*usable* clip. Text-rendering fidelity in-frame, product fidelity from reference images, and clip-level
reliability were not measured on any provider. **A $0.05 model with a 20% usable rate costs $0.25 per
usable clip — worse than a $0.20 model at 90%.** Measure this in week two with a fixed 50-prompt suite
and the same VLM gate, before committing.

### 5.6 Is the abstraction layer worth it?

**Yes, and it is cheap.** Not because you will swap tomorrow, but because:

- **Three verified providers use three incompatible billing units** (per-token, per-generation,
  per-second) and three different task lifecycles. The `estimate_cost(spec)` method is not optional
  for a system with a per-tenant generation budget cap.
- **Every generation vendor rotates model families within release cycles.** The live probe already
  contradicted a locally-installed vendor skill's model catalogue from six weeks earlier.
- **Gemini Omni Flash is a live migration target**: arbitrary 3–10s durations, conversational multi-turn
  video editing, and global-endpoint availability are all better fits for autonomous ad iteration than
  Veo. It is Preview (therefore not indemnified) today. Re-evaluate the moment it reaches GA and joins
  the indemnified-services list.

Keep the interface small: `submit(spec) → task_id`, `poll(task_id)`, `estimate_cost(spec)`, plus a
**per-provider capability descriptor** (durations, resolutions, ratios, audio support, max concurrency,
indemnity status). Drive a **per-model semaphore** from the descriptor, not a global one.

---

## 6. The autonomy engine

### 6.1 The delegation contract — draw this boundary before writing any algorithm

**Meta's delivery system is already a contextual bandit**, running per-impression inside every ad set
(auction total value = bid × estimated action rates × ad quality), backed by Andromeda retrieval, GEM,
Lattice and multi-stage sequence models, improving several percent per quarter. It sees every impression
and information you will never have. **If your bandit also allocates impressions, the two either cancel,
amplify, or confound each other.**

| Meta owns | We own |
|---|---|
| Per-impression allocation | **Which creatives exist** |
| Placement mix | **What to generate next** |
| Audience expansion | **Campaign-level budget** |
| Inter-ad-set budget under CBO | **Experiment structure** |
| Bidding | **Kill switches and spend authority** |

Three hard rules follow, and they are not negotiable:
1. **Never write ad-set `daily_spend_cap` under CBO** — it constrains the campaign-level pacer.
2. **Never use the `ROTATE` execution type**, and never pause ads "for rotation."
3. **Never feed ad-set-level cost into a budget decision under CBO** — Meta deliberately distorts it and
   instructs analysis *"at the campaign level, rather than at the ad set level."* The "expensive" ad set
   may be expensive *because* it is starved.

**Default structure:** campaign-level budget (Advantage campaign budget), `LOWEST_COST_WITHOUT_CAP`,
`advantage_audience: 1`, **zero placement fields**, no ad-set spend limits. Then read back
`advantage_state_info` and treat `DISABLED` as a publish failure. **`advantage_state` is your free
first-party configuration linter** — it tells you when a placement field leaked into your ad set spec.

### 6.2 The reward, and the bug that will cost the most money

**Do not make CVR the reward.** Model conversions-per-**dollar** as **Gamma–Poisson** (shape–rate;
prior `k₀ = 1`, `r₀ = target_CPA`, i.e. worth one conversion's spend). For ROAS objectives use a
**two-part hurdle model** (Poisson–Gamma count × LogNormal order value) so one large order cannot make
a bad creative look like a winner.

**Then apply the delay correction, in the only place it belongs — the posterior update:**

```
s_effective = spend × F(age)          # deflate the EXPOSURE, never inflate the numerator
θ | data ~ Gamma(k₀ + conversions, r₀ + s_effective)
```

Fit `F(a)` non-parametrically from settled (>28-day-old) cohorts per account, falling back to a
vertical-pooled curve or Kaplan–Meier on your own CAPI click→conversion stream.

**Why this is the single most expensive bug available:** a 2-day-old ad has ~55% of its conversions
reported; a 7-day-old ad ~95%. Compare them directly and you systematically kill the newest creative —
which is exactly the creative the generator just made. **The symptom is "the AI keeps rejecting its own
work," and it is a data bug, not a model bug.**

**Order matters:** completeness-correct **first**, then discount for recency. Doing it the other way
makes the system permanently pessimistic about the present.

### 6.3 Thompson sampling, and why not UCB

**Thompson sampling with posterior reshaping (`α = 0.5` default, per-account knob).** The argument is
specifically about delay, not fashion: Chapelle & Li's own delayed-feedback table shows UCB regret
growing **9.4×** as batch delay goes 1→1000 steps while TS grows **6.5×**, with the UCB/TS ratio
widening from 2.65 to 3.82. Our delay is measured in days.

Use deterministic upper-confidence bounds only where you need an **explainable** kill decision. Log the
TS Monte-Carlo win probabilities as **propensities on every decision** — without logged propensities,
nothing about your own policy is evaluable later.

### 6.4 The decision rule

**Bayesian expected loss against a threshold of caring, `X = 20%`.** Never a fixed-horizon p-value.

```
KILL        when P(CPA_new > 1.20 × CPA_incumbent) ≥ 0.80
SCALE       when P(CPA_new < CPA_incumbent)        ≥ 0.85
EQUIVALENT  when the ROPE mass ≥ 0.90
HOLD        otherwise
```

**Make the kill threshold stricter than the keep threshold**, because the learning-phase reset cost of
replacement is real. And note: **`HOLD` is the modal decision and must be a first-class outcome, not a
fall-through.** "Probably worse but not confidently worse by enough" is where most creatives live most
of the time, and a system that cannot represent that state will thrash. `EQUIVALENT` exists to stop
re-litigation.

**Every decision passes these gates first. All must hold.**
```python
DECISION_GATES = dict(
    min_age_days               = attribution_click_window_days,   # 7 on a 7d_click account
    min_spend                  = 1.5 * target_cpa,
    min_impressions            = 1000,          # also Meta's floor for ranking diagnostics
    not_learning               = "learning_stage_info.status != 'LEARNING'",
    settled_rows_only          = "date_stop <= today - attribution_window",
    same_attribution_setting   = True,          # never aggregate across differing values
    completion_corrected       = True,
    no_significant_edit_within = 3,             # days since last_sig_edit_ts
    delivery_healthy           = "effective_status == 'ACTIVE' and impressions_last_24h > 0",
    account_eligible           = "account_status == 1 and funding_source is not None",
)
```
That last gate is the §1.3 finding made mechanical: **zero-impression cohorts are a distinct state, not
a bad-performance state, and must never update a creative prior.**

### 6.5 How it learns transferable lessons rather than just picking winners

This is the part that separates the product from a rules engine, and it rests on three artifacts.

**(a) The creative attribute vector — the most important schema in the system.**
Versioned, controlled-vocabulary, emitted at **generation** time (not tagged after the fact), and split
into **levers** (choosable: angle, hook_tactic, mechanic, psychological_trigger, format, asset_type,
offer_type, offer_value, awareness_stage, landing_page_id) and **observed** (things you measured about
the render). Plus `assignment ∈ {randomised, exploit, human_override}`, `parent_creative_id`, and
`hypothesis_id`.

**Encode the full genome tuple into the Meta ad name at creation time.** Attribution then survives a DB
loss and any third-party analytics tool can group by it:
`{angle_id}|{stage}|{mechanic}|{hook_tactic}|{trigger}|{format}|{asset_type}|{offer}|{variant_n}|{yyyymmdd}`

Model the genome as **multi-label with time spans**, not single-label. A 45s UGC ad is a *sequence*
(Problem Agitation → Demo → Testimonial → Offer), and published format co-occurrence data exists to seed
a sequence prior.

**(b) Forced randomisation — the only unconfounded evidence in the system.**
Reserve **~20% of new-creative slots** for lever values drawn from a fixed distribution **the LLM cannot
see**. Without it, "attribute effects" are the LLM's own preferences wearing a lab coat: observational
spend data yields spend-*allocation* coefficients, not causal creative effects.

**One caveat the dossiers disagreed on and this document resolves:** the 20% slice is **unaffordable at
cold start on a $50/day account**. Make the exploration schedule a **function of budget**, not a
constant: a hard floor of 10%, a default of 20%, and at micro tier a *sequential* randomisation over
weeks rather than a parallel slice.

**(c) Hierarchical partial pooling.**
Fit a Bayesian logistic/Poisson regression over the attribute vector with coefficients pooled across ad
sets → accounts → verticals. A per-ad Beta posterior learns nothing about creative #37; an attribute
model does. Use **BOLS (batch-wise OLS, then combine)** as the default estimator for any attribute
effect shown to a user — it is nearly free given you already batch decisions, and it restores asymptotic
normality on adaptively-collected data.

**Store learned knowledge as a typed `learned_claims` table** — `scope_kind`/`scope_id`, effect on
**log** CPA, provenance, `attribution_regime`, `supersedes`, `status`, `decay_halflife_days` — retrieved
by query with time-decayed confidence. **Never as a growing prompt blob.** Feed refuted claims back as
"already tried" so the LLM stops re-proposing them.

**Promotion rule:** a claim moves from account scope to vertical scope only when the hierarchical
credible interval excludes zero **and ≥3 distinct accounts contributed randomised evidence.** This is
the compounding-knowledge mechanism and it must be conservative.

> **⚠ Legal gate on cross-tenant learning.** Developer Policy 10.7(b): *"Only use data from an
> end-advertiser's campaign to optimize or measure the performance of that end-advertiser's Meta
> campaign."* 10.7(g): *"Keep Meta's data that you maintain on behalf of one advertiser separately from
> that of other advertisers."* Taken together, **a model trained on tenant A's Meta performance data and
> then used to optimise tenant B's campaigns is presumptively non-compliant.** Get legal review before
> shipping one. The safe design is per-tenant models plus **non-Meta-derived priors** — priors learned
> from your own randomised design choices, published benchmarks, and creative attributes you generated,
> rather than from Meta's reported performance numbers. This constraint materially weakens the
> "cross-account learning" pitch and you should know that before you build a company around it.

### 6.6 The LLM's role — proposes, never disposes

**Give the LLM no Meta credentials.** Its only writes are `POST /hypotheses` and
`POST /creative_briefs` into a gated queue. It receives **shrunk posteriors with n, credible intervals
and provenance** — never raw metrics. A deterministic validator rejects any record with
`claim_type='causal'` that lacks randomised evidence.

What the LLM is genuinely good at here: generating diverse angles and hooks; reading a retention curve
and proposing *which second* to re-cut; writing the script; and — via a policy classifier prompted with
**verbatim policy text** and **required to quote the clause it is citing** — pre-flight compliance
review. Requiring the quote is what stops the classifier hallucinating rules.

What it is not allowed to do: declare a winner, touch a budget, assert causality, or decide what "worked."

### 6.7 The cadence — and the one scheduling decision that matters most

| Job | Frequency | Why not faster |
|---|---|---|
| Guardrail sweep | **15 min** | Insights refresh ~15 min; faster is pure quota waste |
| Insights sync | hourly + daily rolling-28-day | 28-day mutability |
| Posterior update | daily 06:00 account TZ | conversions settle on a daily clock |
| Budget decision | daily, **before noon account TZ** | Meta: *"limit yourself to 2-3 times a day and only the early part of the day"* |
| **Creative decision** | **WEEKLY, one maintenance window** | **every add/remove is a significant edit** |
| Hierarchical refit | nightly | batch job, minutes |
| Hypothesis cycle | weekly, after the creative window | matched to the creative window |

**The weekly creative window is the highest-leverage scheduling decision in the build.** Adding or
removing *any* ad from a live ad set is **always** a significant edit that restarts the ~50-event /
7-day learning phase for the whole ad set. Trickling one ad at a time restarts learning every time. One
batched window per week costs **one** reset and gives the ad set six days to stabilise.

**All pauses and all launches happen inside that one window.** If you take one idea from this section
into the code, take that one.

### 6.8 Budget mechanics you must model or you will overspend

- **Daily budget is not a daily cap.** Up to **75% overspend** in a day is documented in the v24.0
  changelog (the budgets guide still says 25% — a live doc conflict, §12), with a weekly cap and a
  Saturday-midnight reset. **The 175% daily ceiling anchors to the HIGHEST budget set that day**, so
  writing a large budget and immediately writing it back does **not** undo the exposure. **Model budget
  writes as irreversible for the calendar day** and enforce a per-ad-set upward-write ceiling in your own
  scheduler.
- **4 ad-set budget changes per hour, hard** (`613/1487632`). A continuous-tuning optimiser is
  structurally impossible. Budget writes go into a **priority queue**; the optimiser proposes into it and
  never calls the API directly.
- **10 ad-account spend-limit changes per day** (`17/1885172` — different code family, branch on both).
- **Allocate by equalising *marginal* CPA, not average CPA**, using Hill saturation curves estimated
  **only from deliberately randomised ±15% budget perturbations.** Observational budget-vs-CPA data
  recovers your own past decision rule, not the response curve.
- **Clamp every write:** ±20%/day, ≥ `/minimum_budgets` for the account currency, ≤2 writes/day, before
  noon account time, against a monotone daily high-water mark, and **skip entirely when
  `learning_stage_info.status == 'LEARNING'`.**
- Use **`budget_schedules` high-demand periods** for all *planned* scaling (launches, sales, paydays) —
  they are declared ahead of time and do not read as a mid-flight budget edit. Reserve direct
  `daily_budget` writes for reactive changes. Note the mutual exclusion: budget scheduling requires a
  **daily** budget; ad scheduling / `pacing_type=day_parting` requires a **lifetime** budget.

### 6.9 Guardrails — hard stops, not dashboards

Native Meta ad rules are the **dead-man's switch**, not the control loop. Use ~5 per account, because
they evaluate server-side even when your infrastructure is down:

- `PAUSE` on `spent > hard_cap` — **spend is not a "cost condition"**, so error `2703` does not apply.
  (Error 2703: *"Rules that turn off ads can't have cost conditions"* — which is exactly why cost-based
  pausing must live in your own loop.)
- `PAUSE` on `frequency > N` gated by `hours_since_creation`.
- Mirror `NOTIFICATION` rules.
- One `TRIGGER` + `PING_ENDPOINT` rule per account to wake your loop cheaply (p99 ~7.5 min on insights
  changes) instead of polling.
- **Never ship an `UNPAUSE` rule.** The real risk is inverted from the folklore: `UNPAUSE` rules use an
  implicit `NOT_IN ['DELETED','ARCHIVED']` filter, so they **do** see paused objects and will happily
  reactivate ads your loop deliberately paused. (§12)

Your own circuit breakers, all implemented as **hard stops**:

| Guard | Trigger | Action |
|---|---|---|
| Per-tenant daily generation budget | non-media cost today > cap | halt generation, page |
| Publish velocity | > ~20 ads/ad_account/hour | reject further publishes, require human token |
| **Regeneration ratio** | `renders_created / ads_published > 10` over 24h | halt concept generation — this is the prompt/validation loop signature |
| **Spend authority drift** | Σ Meta `daily_budget` of ACTIVE ad sets ≠ `spend_authority.committed` ± 1% | **pause all ACTIVE campaigns on that account, page** |
| Meta error rate | 4xx/total > 10% over 1,000 calls | throttle to 10% — this directly protects your insights quota |
| Duplicate detection | >1 result from a `*bylabels` reconciliation | immediate stop |
| **Zero-delivery** | ACTIVE for 24h with `impressions == 0` | escalate — likely `PENDING_BILLING_INFO` or missing DSA fields |
| Rolling 30-day disapproval rate | > ~2% per ad account | **auto-suspend generation for that account** |
| Template disapproval rate | > ~10% for a prompt template's children | retire the template |

Plus two structural safeties: a **global kill switch readable by every workflow at every step and
settable without a deploy**, and a **monotonic daily spend ceiling per ad account enforced in your own
code** — Meta's `spend_cap` is an account-*lifetime* cap with a $100 minimum, applies only to spend
*after* it is set, and needs a scheduled `spend_cap_action=reset`; a forgotten reset silently stops all
delivery on the 2nd of the month.

**Four one-call kill switches you must be able to pull:** pause every ad on an account; pause every ad
sharing a creative lineage (IP complaint); pause every ad pointing at a landing-page domain; global
publish freeze (a policy change landed and your classifiers are stale).

**And note the one that is not a kill switch: `DELETE` is not a kill switch.** Deleted ads may still
accrue impressions, clicks and actions for 28 days. Only `status = PAUSED` stops spend.

### 6.10 Proving the system works

**Not from before/after.** Gordon et al., using Facebook's own data, showed observational methods fail
to recover experimental effects. Three designs actually produce a defensible answer:

1. **Paired switchback** — AUTO vs FROZEN alternating 2-week blocks with a 3-day washout. **15
   account-week pairs detects a 20% improvement; 54 pairs detects 10%.** Build this first.
2. **Geo holdouts** via targeting exclusions, read back with `breakdowns=country/region`.
3. **Fleet-wide account randomisation** — 118 accounts/arm for 20%. Reserve for the marketing claim.
   ⚠ Running a deliberately worse policy on paying customers' accounts is an ethics and ToS question
   that must be resolved **before** the experiment is designed (§11).

**Instrument the system's own scorecard**: premature-kill rate (<5%), learning-phase occupancy (<30% of
ad-set-days), surrogate validity (Kendall τ ≥ 0.3 between day-2 impression share and settled CPA rank),
and 90%-interval coverage calibration ≈ 0.90. **Log a predicted effect + CI on every decision so
calibration is measurable at all.**

**Run two weeks of SHADOW MODE** — full loop, every action logged, none executed — against a live
account before launch. It will surface the age-confound bug and the edit-thrashing bug before either
costs money.

### 6.11 What "what to make next" actually means — the creative economics

The generation policy is constrained by a power law, and getting this wrong wastes the entire budget.

**~5% of creatives are winners** (≥10× account-median spend and ≥$500); **winners take 55% of spend**;
**~50–53% of creatives are killed before day 28 in every spend tier.**

Five consequences:
1. **`is_winner` is an account-relative outlier**, not an absolute CPA gate:
   `(spend / account_median_creative_spend >= 10) AND (spend >= 500)`. An absolute threshold
   mis-classifies across tiers.
2. **The primary output metric is `winners_per_month`, not average creative quality.** Volume does not
   make the average ad better; it increases how often you run into something exceptional.
3. **Hit rate must never be a top-line KPI.** 50 launches → 5 winners (10%) beats 5 launches → 1 winner
   (20%). **If the system optimises hit rate it will learn to stop testing.**
4. **Budget the loser tranche as expected cost.** At micro spend ~31.5% of spend definitionally goes to
   ads killed before day 28. That is the price of the option, not waste.
5. **Protect the mid-range.** 38–46% of creatives are "ballast" that keeps performance steady while new
   ideas compete. A naive "pause anything below target ROAS" rule deletes the account's stability layer.

**The objective function must be CONSTRAINED, not a weighted sum:** maximise `winners_per_month` (or
margin) **subject to** hook rate, hold rate, CTR and CVR each staying above account-relative floors.
This is the single highest-risk design decision in the engine — a weighted sum lets the optimiser trade
CVR for CTR and silently destroy the account.

**Cap variants per concept at ~2 and enforce a semantic-diversity floor on every launch batch** (pairwise
distance over `(angle, mechanic, hook_tactic, format, asset_type)` plus script and first-frame
embeddings). Meta's 2026 Andromeda retrieval change reportedly collapses near-duplicate ads, and
`FRAGMENTATION_V3` plus the 150-combination ceiling punish undifferentiated volume. **The naive "AI makes
500 variants" pitch is inverted: cap variants, spend capacity on angles.**

**Stage by cost.** Stage 1 discovers the winning `(angle, hook_tactic, offer)` triple using cheap
text-forward and UGC-style statics and short clips at volume — the evidence says **text-forward and UGC
assets beat high-production on hit rate, and high production is mid-pack**. Stage 2 spends real video
budget only on angles that already proved out. A system that opens with expensive generated video on
unproven angles burns money exactly where production value matters least.

**Test order** (largest swing first): offer → messaging angle → awareness stage → mechanic → hook tactic
→ format → asset type → minor variations. And **tie creative refresh to measured decline AND exhaustion
of the angle's variant space — never to elapsed time.** An AI has no fatigue instinct and will default
to either never rotating or rotating on a cron; both destroy value.

**The fatigue-response ladder, in decay order:** regenerate the **hook** first (only the first 1–3s, hold
body/offer/copy constant), then visuals, then CTA. Cheapest intervention targets the fastest-decaying
component. Model fatigue as `logit p_a(t) = μ_a − λ_a·Φ_a(t)` with λ pooled per vertical, and make the
kill decision **economic** (expected remaining value vs best challenger minus switching cost) rather than
a hardcoded frequency threshold — Meta publishes none.

**Keep a fixed, non-negotiable exploration slot (~20–30% of weekly launches) on the high-variance
"interrupt" hook cluster** (Confession, Contrarian, Shocking Statement, Warning, Myth Busting). A greedy
bandit will starve them because they have lower hit rate; they are also the season-stable ones.

**Always keep one stable "control" creative running** to absorb account-level seasonality and auction
drift. Every comparison then becomes a ratio to the control in the same window, which cancels both
exactly and separates "the world changed" from "this creative changed."

---

## 7. Competitive positioning

### 7.1 The market map

Roughly 60+ live products touch some part of the Meta ads loop. They stratify cleanly, and **almost
every vendor sits in exactly one layer and claims two.**

```
LAYER 0  PLATFORM — Meta itself
         Advantage+ suite · asset_feed_spec · degrees_of_freedom_spec · generative_asset_spec
         Ad Rules Engine · opportunity_score · /recommendations (read+apply) · creative_fatigue webhooks
         mcp.facebook.com/ads (WRITE tools) · `pip install meta-ads` official CLI
         → free, native, improving, and eating the layer above it

LAYER 1  CREATIVE GENERATION — "makes the asset"          → race to zero
         AdCreative.ai · Creatify · Arcads · Omneky · Pencil · The Brief (ex-Creatopy)
         HeyGen · Synthesia · Captions · MakeUGC · TopView · Higgsfield · Icon (now human)

LAYER 2  CREATIVE ANALYTICS — "tells you what to make next" → happiest customers, best margins
         Motion ($750–1,200/mo) · Foreplay ($59–459) · Atria ($129–959) · Superads ($125+)
         VidMob · Neurons · Segwise · Marpipe

LAYER 3  CAMPAIGN AUTOMATION / DCO — "operates the account" → being repriced by Meta
         Revealbot/Bïrch ($49–99) · Madgicx · Smartly · Hunch · AdEspresso ($49–259) · Adzooma
         Celtra · Storyteq · Bannerflow · Enhencer · Skai

LAYER 4  CLAIMED FULL AUTONOMY — "does all of it"          → mostly L2 or L3 with a chat box
         Creatify · Omneky · Enhencer · Segwise · Metadata.io · Madgicx · Atria
```

### 7.2 Who actually closes the loop?

The loop is: **generate → publish → measure → attribute → learn → generate better, with no human in the
seat.**

**Nobody verifiably closes it unattended.** Every strong claim decomposes into one of three patterns:

1. **"One-click" / "Approve & Launch"** — a human is the gate. *The word "one-click" appears as a
   competitive **feature** in Atria's own grid — meaning the industry's best-in-class is "a human clicks
   once."*
2. **"Tells you exactly what to do next"** — an advisor, not an operator (Madgicx AI Marketer, Motion,
   Atria Radar).
3. **"Closed-loop pipelines built with you"** — a services engagement, not a product (Motion Growth,
   sold above $125k/mo spend).

Metadata.io deserves credit for stating the constraint plainly instead of marketing around it: *"Your
team reviews budget, approvals, channel structure, and pipeline evidence **before anything goes live**."*
That is the honest state of the art in 2026.

**The market's loudest signal:** Icon (icon.com) raised $30M+ from Founders Fund and OpenAI/DeepMind
leaders as "The AI Admaker" — and **pivoted to selling human-filmed UGC at $1,000 for 6 ads, explicitly
marketed "no AI / 100% real."** Whatever you build must have an answer for why AI creative clears the
DTC performance bar when the best-funded player in the category concluded it didn't. **The answer is not
"better models"; it is product fidelity plus volume economics plus the closed loop** — Icon abandoned the
generation layer, which is exactly the commoditised layer.

### 7.3 What Meta already gives away free

| Meta capability | What it commoditises |
|---|---|
| Advantage+ audience / placement / budget | Targeting optimisers, "AI targeting" as a category |
| `degrees_of_freedom_spec` (~23 documented transforms, 7 explicitly AI-generated) | auto-resize / auto-variant features across Layer 1 |
| `asset_feed_spec` + asset customization rules | basic multivariate testing |
| Ad Rules Engine (`adrules_library`) | the entire Layer 3 rules commodity |
| `opportunity_score` + `/recommendations` (read **and apply**) + `creative_fatigue` webhooks | "detect underperformance → recommend fix → apply fix" dashboards |
| **`mcp.facebook.com/ads`** with write tools | "chat with your Meta ads" agents |
| **`pip install meta-ads`** (v1.1.0, first released 2026-04-29) under a new docs section called **"Ads AI Connectors"** | the entire "we wrap the Marketing API for agents" thesis, including most open-source MCP servers |
| Meta's own incremental attribution (reported +24% incremental conversions vs standard) | the "we measure true incrementality" pitch |

**Meta charges $0 for all of it.** Its revenue is the ad spend; the automation exists to increase and
retain that spend.

**Do not build:** a targeting optimiser, a rules engine, a "chat with your Meta ads" agent, a
recommendations dashboard, or basic creative variation. All four are free, first-party, and improving.

### 7.4 What Meta structurally will not do

1. **Originate video from your product's physical truth.** Meta *animates, uncrops, reframes, regrades,
   re-captions and translates* assets you already supplied. Every documented Meta video feature is a
   transform: `image_animation`, `video_uncrop`, `video_filtering`, `translate_voiceover` (English→
   Spanish **only**), `video_slideshow`. **Meta has not shipped text-to-video ad generation.** Muse Video
   is a preview "coming soon to creators and Meta AI," not to Ads Manager. **Video origination is the
   moat.**
2. **Reason about your angle and your offer.** Meta has never claimed this layer and cannot measure it,
   because it does not know your angles exist. **Make ANGLE a first-class entity** with its own ID,
   hypothesis and performance record (angle → concepts → creatives → ads) and run a bandit over angles.
   Per-angle attribution is a reporting asset Meta cannot replicate.
3. **Edit your landing page.** Meta's automation stops at the click. Generate destination variants as
   part of the same unit as the angle and the creative — they share one `Offer` object and one hash.
4. **Optimise your contribution margin.** Meta optimises revenue/ROAS. Send **margin** (or a
   margin-scaled proxy) as the CAPI `value`, then use `optimization_goal=VALUE` with
   `LOWEST_COST_WITH_MIN_ROAS`. **This is the most defensible economic argument available and the single
   highest-leverage design decision in the product** — with an explicit signal-sparsity trade-off to
   budget for.
5. **Own the measurement.** Meta marks its own homework. This is why Motion sells Northbeam integration,
   Bïrch sells Hyros/Wicked Reports/AppsFlyer, and Madgicx sells server-to-server Tracking Pro at
   $49/mo. **An independent measurement substrate is the most defensible layer left, because Meta is
   structurally disqualified from providing it.**
6. **Take responsibility for a business outcome.** Advantage+ optimises what you tell it to. It will not
   decide your $2,000/mo should go to a different product, a different offer, or no ads at all.

### 7.5 The five recurring complaints — and where they point

Aggregated Trustpilot distributions, read 2026-09-02 `[SECONDARY]`:

| Vendor | TrustScore | Reviews | % 1-star |
|---|---|---|---|
| Madgicx | **1.7** | 271 | **46%** |
| Arcads | 2.7 | 170 | 46% |
| Omneky | 2.9 | 45 | 47% |
| AdCreative.ai | 3.4 | 4,488 | 33% |
| Revealbot/Bïrch | 3.8 | 18 | 28% |
| Creatify | 4.0 | 824 | 16% |

1. **Output that doesn't survive contact with a real brand.** *"All scenes are messed up, language is
   absolutely different than the language i wrote in the prompt."* **Prompt adherence and product
   fidelity are the #1 failure, not aesthetics.** If your system autonomously spends money on an ad
   showing the wrong product, the loop is not merely useless — it is negatively valuable.
2. **Credit systems that make unit cost unknowable.** Atria meters credits **and** analysed ad spend
   **and** seats simultaneously. Buyers cannot forecast cost, so they churn.
3. **Billing as the business model.** Bimodal 50/46 and 55/33 five-star/one-star splits are the
   fingerprint of a company whose revenue depends on failed cancellations. **This is the category's
   biggest reputational liability and the clearest positioning opportunity.**
4. **No real learning.** Every vendor advertises corpus scale ("$35B in ad spend trained"). **Not one
   publishes evidence that generation N+1 improved because of *this brand's* measured results.**
5. **Still needs an operator.** Bïrch's own testimonial is the tell: automation cut an 8-hour day to
   1–2 hours — of creative work. **Nobody got to zero.**

**Two complaints conspicuously absent from the entire public record**, and this is where the product is:
- **Nobody markets autonomous recovery from ad policy rejections.** The only adjacent product in the
  whole sweep is AdCreative.ai's advisory "Compliance Checker."
- **Nobody advertises learning-phase discipline.** Rules engines act on thresholds, which is exactly how
  you destroy a campaign that would have converged.

### 7.6 Where the real gap is

**Everything on the shelf is a component. Nobody sells the machine.** Five specific gaps, ranked:

1. **The unattended gap.** A system whose only recurring human action is reading a weekly summary does
   not exist commercially.
2. **The failure-handling gap.** Policy rejections, learning-phase resets, account restrictions, creative
   fatigue, attribution lag and payment failure are the reasons a human is still in the seat. **No vendor
   markets autonomous handling of any of them.** An autonomous system is defined by what it does when
   things go wrong at 3am, and that is entirely unclaimed territory. **This — not creative quality — is
   the real reason full autonomy doesn't exist, and it should be the core of the product, not an
   afterthought.**
3. **The fidelity gap.** Solve product fidelity **before** you earn the right to spend unattended,
   because the cost of an unattended wrong-product ad is wasted media plus brand damage, not a wasted
   render.
4. **The learning gap.** A durable per-account feature store keyed on `(creative attribute → measured
   outcome)`, with randomised evidence, is the differentiator. Corpus-scale claims are not.
5. **The trust gap.** A product that takes ad-account credentials and spends money must be *radically*
   more trustworthy than the incumbents: transparent unit economics on one meter, hard spend caps, a
   one-click kill switch, no dark-pattern billing. **Cheap to build, currently wide open.**

### 7.7 Positioning, in one paragraph

Do not position as "AI that makes ads" (commoditised, distrusted, Icon abandoned it) or as "AI that runs
your Meta ads" (Meta gives it away at `mcp.facebook.com/ads`). Position as **the unattended operator that
keeps working when things go wrong** — with video origination grounded in the client's real product,
angle-and-offer strategy Meta has never claimed, margin-aware optimisation Meta is structurally
disqualified from, and a per-account learning record that is legible to the client. **Price on creative
production displacement or per-account-plus-outcome, never as a percentage of ad spend** — a spend-based
fee aligns you with Meta's objective and against the advertiser's margin, which directly contradicts your
own differentiation story.

---

## 8. Cost model

All figures 2026-09-02. Media spend is excluded throughout — it is the client's money, passed through.

### 8.1 Cost per finished ad (24s, 9:16 master + 4:5 + 1:1 derivatives)

| Line item | **Volume** | **Standard** | **Hero** |
|---|---|---|---|
| Brief → script → storyboard (LLM) | $0.017 | $0.017 | $0.09 |
| Keyframes (3) | $0.10 | $0.40 | $0.72 |
| Product-fidelity edits | — | $0.09 | $0.18 |
| **Video (24s, audio-off)** | **$0.72** (Veo 3.1 Lite 720p) | **$2.40** (Veo 3.1 Fast 1080p) | **$4.80** (Veo 3.1 1080p) |
| Voiceover | $0.005 | $0.018 | $0.035 |
| Music | $0.00 (cached bed) | $0.06 | $0.06 |
| Forced alignment | $0.002 | $0.002 | $0.001 |
| QA VLM | $0.006 | $0.02 | $0.08 |
| ffmpeg compute (all passes + 3 ratios) | $0.005 | $0.005 | $0.008 |
| Subtotal | $0.855 | $3.01 | $5.98 |
| Retry multiplier | ×1.2 | ×1.0 | ×1.4 |
| **Realistic total** | **≈ $1.03** | **≈ $3.01** | **≈ $8.37** |

**The dominant line is video seconds. Everything else is rounding.** Two levers matter and nothing else
does:
- **Audio-off halves Veo 3.1 on Vertex** ($0.40/s → $0.20/s). Synthesise your own VO and music; this also
  removes a whole failure class (audio-related safety blocks) and gives you a licence record.
- **Draft/Lite tiers for exploration.** FLUX 3 draft at $1.44 for 24s, or Veo 3.1 Lite at $0.72 —
  a ~3× saving on the dominant line during the angle-exploration phase, with only survivors re-rendered.

Not in the table because it is genuinely free: **per-shot content-addressed caching.** A new-hook variant
costs ~$1.05 against ~$2.95 for a full ad; **a new aspect ratio costs ~$0.** This is the whole reason the
ShotList IR is the product.

### 8.2 Cost per advertiser-month

Modelled on a **Small tier** advertiser ($10k–$50k/month media spend), whose benchmark testing volume is
4.1 creatives/week (median 4.0; top-quartile 8.0). Two-stage funnel: explore cheap, promote winners.

| Item | Monthly | Basis |
|---|---|---|
| 40 exploration renders @ Volume tier | $41 | ~10/week discovery batch |
| 8 promoted renders @ Standard tier | $24 | winners re-rendered at quality |
| Statics via layer decomposition + templates | ~$5 | near-zero marginal after the hero static |
| Landing-page / destination variants | ~$3 | LLM + template render |
| Preview rendering (7 formats × headless) | ~$2 | Playwright compute |
| Policy pre-flight (LLM + vision, ~48 creatives) | ~$8 | the cheapest insurance in the system |
| Insights sync + decision compute | ~$4 | ~750 API calls/day + nightly refit share |
| Storage (R2, ~220MB/concept, accreting) | ~$2 → $8 by month 12 | $0.015/GB-mo, **$0 egress** |
| **Generation + variable COGS** | **≈ $89/mo** | |
| Amortised platform infra (see 8.3) | **$15–30/mo** | at 100 accounts |
| **Total COGS per advertiser-month** | **≈ $105–120** | Small tier |

**Scaling by tier** (dominated by creative volume, which is set by the tier × vertical cell, **not a
global constant**):

| Tier | Media spend/mo | Creatives/mo | Generation COGS | Total COGS |
|---|---|---|---|---|
| Micro | <$10k | ~12 | ~$25 | **~$45/mo** |
| Small | $10–50k | ~18 | ~$89 | **~$110/mo** |
| Medium | $50–200k | ~29 | ~$150 | **~$180/mo** |
| Large | $200k–1M | ~48 | ~$260 | **~$300/mo** |
| Enterprise | $1M+ | ~82 | ~$450 | **~$500/mo** |

### 8.3 Platform infrastructure

| Item | Cost | Note |
|---|---|---|
| Temporal Cloud (Essentials) | **$100/mo minimum** + $50/M actions (first 5M) + $0.042/GB-h active storage | **No free tier.** Support minimum is the greater of $100/mo or 5% of spend |
| Postgres (managed, partitioned metric store) | $200–600/mo | grows with `metric_snapshot` |
| Redis (shared rate-limit buckets) | $50–150/mo | **must be shared** — a per-process limiter is useless with 20 workers on one account |
| Cloudflare R2 | $13/mo at month 1 → **$159/mo at month 12** (10.6 TB) | at 100 advertisers × 40 concepts/mo |
| AWS KMS | ~$1–4/mo total | 1 CMK per region per env, **not per tenant**; ~$0.52/mo in requests at 100 tenants |
| Compute (workers, ffmpeg, headless Chrome) | $300–1,000/mo | ffmpeg ran at ~18× realtime `[MEASURED]` |
| Observability | $100–300/mo | |
| **Fixed platform floor** | **≈ $800–2,200/mo** | |

**R2 over S3 is decided by the egress asymmetry, not the storage price.** Meta pulls each delivery video
via `file_url`, and dashboard previews multiply that. R2 egress is **$0**; S3 at ~$0.09/GB is ~$32/mo at
360 GB and scales with your UI usage — the thing you least want coupled to a storage bill.

**Storage discipline that actually matters:** delete source clips for concepts that never produced a
published ad, after 60 days. That is typically **40–60% of total bytes** with no future value. Never
delete delivery derivatives of ads that ran, the render manifest, or thumbnails — you need them for
audit and for the learning corpus. (Watch R2 Infrequent Access's **30-day minimum billing duration**:
do not tier objects you might delete next week.)

### 8.4 The unit-economics view you must have on day one

```sql
cost_per_published_ad = Σ(cost_event WHERE category != 'MEDIA_SPEND') / count(publish_record)
generation_cost_to_media_spend_ratio  -- per campaign
```

**If `cost_per_published_ad` exceeds ~5–10% of the ad's media budget, the product does not work.** At
$3/ad and a $100/day ad set that is fine; at $8/ad against a $5/day micro-tier ad set it is not — which
is another argument for tiering the generation quality by account spend.

**`generation_cost_to_media_spend_ratio` is your runaway-loop detector.** Generation cost climbing while
media spend is flat means you are regenerating without publishing — the prompt/validation loop
signature.

### 8.5 What this implies for pricing

The competitive floor is low and the ceiling is anchored by analytics: AdEspresso $49/mo (with a
$1,000/mo spend cap), Bïrch Pro $99/mo, The Brief $29–79/mo *with real publishing*, Creatify $99/mo with
a Meta Ad Launcher — against Motion at **$750–$1,200/mo** priced on analysed spend.

**Recommended shape: one transparent meter.**

| Tier | Price | COGS | Gross margin |
|---|---|---|---|
| Starter (micro, lead-gen/on-Meta destinations only) | **$199/mo** | ~$45 | 77% |
| Growth (small) | **$499/mo** | ~$110 | 78% |
| Scale (medium) | **$999/mo** | ~$180 | 82% |
| Enterprise (large+) | **$2,000+/mo** or per-account-plus-outcome | ~$300–500 | 75–85% |

Three principles behind those numbers:

1. **Price against creative production displacement, not against software.** An advertiser paying a
   studio $1.5k–$15k per video concept, or a freelancer $300–$800 per UGC-style ad, has a large legible
   budget line you are substituting. That is the only place the buyer's existing spend is both large and
   clearly substitutable — and Meta's tools do not touch it, because Meta cannot originate video.
2. **Never price on a percentage of ad spend.** It aligns you with Meta's objective (more spend) and
   against the advertiser's (more profit), contradicting your own margin-aware differentiation story. It
   also pulls you toward agency/broker regulation in several jurisdictions, and it compounds a billing
   failure with a payment failure when the client's card declines.
3. **Publish real prices.** Arcads, Madgicx, Smartly, Hunch, Enhencer, Omneky and VidMob publish none.
   In a category where "hidden credit consumption" is a top-five complaint everywhere, **a published
   price on one meter is itself a differentiator.**

**Break-even sanity check:** at $499/mo and ~$110 COGS, the $800–2,200/mo fixed floor is covered by
**3–6 Growth accounts**. The business is viable early; the risk is not unit economics, it is the
onboarding funnel (§4.1) and the account-safety tail (§9).

---

## 9. Risk register

Ranked by **expected cost = likelihood × blast radius**. "Blast radius" is stated as the worst realistic
outcome, not the average one.

### R1 — Business portfolio restriction (existential)
**Likelihood: Medium.** **Blast radius: Total — every client on that portfolio, unrecoverable via API.**

The threat model is not "an ad gets rejected"; it is "the Business Account gets restricted." Meta's Spam
standard explicitly names creating assets *"either manually or automatically, at very high
frequencies"*. Account Integrity enforcement is **portfolio-transitive** (`disable_reason = 11
BUSINESS_MANAGER_INTEGRITY_POLICY`). Meta is driving toward *"verified advertisers drive 90% of our ads
revenue by the end of 2026, up from 70% today"*, and in Feb 2026 sued cloaking/celeb-bait advertisers
and sent cease-and-desists to eight consultants selling un-ban and account-rental services. **A
high-volume automated publisher sits squarely in that risk surface. And there is no appeals API.**

**Mitigation:**
- **One Business Manager per client. Never a shared portfolio.** This is not optional.
- **Rolling 30-day disapproval rate as a hard SLO:** auto-suspend generation above ~2% per account;
  retire any prompt template whose children are disapproved above ~10%. This is the highest-leverage
  account-safety control entirely within your control.
- **Cap automated remediation at 2 attempts per creative lineage**, then quarantine and page. An
  unbounded generate→submit→reject→regenerate loop is a machine for accumulating violations.
- **Per-account daily publish cap = f(account_age, 30d_spend, rolling_disapproval_rate).** Never launch
  N creatives simultaneously on a fresh account: `validate_only` → PAUSED create → 1 ad / 1 ad set /
  floor budget / 24h → scale ad count → scale budget.
- Poll `account_status` and `disable_reason` **before every publish batch**, not on a daily cron, and
  route: `1 ADS_INTEGRITY_POLICY` → creative remediation; `2 ADS_IP_REVIEW` → legal, halt asset lineage;
  `11`/`12` → **stop publishing across the whole portfolio**; `7 PERMANENT_CLOSE` → terminal, migrate the
  client. Subscribe to the `ad_account` webhook so you learn without polling.
- Collect business-verification data at onboarding and treat "verification pending" as a first-class
  state that blocks publishing.

### R2 — Runaway spend
**Likelihood: Medium-High** (it is the default behaviour of a naive loop). **Blast radius: $1k–$10k+ per
incident, and the money is allocated between you and the client by your contract alone — Meta's
liability is capped at $100.**

Compounding mechanics: daily budgets can overspend **75%**; the **175% ceiling anchors to the day's
highest budget**, so writing a large budget and writing it back does not undo the exposure; there are
**no idempotency keys**, so an ambiguous retry can double an ACTIVE tree; and `DELETE` is not a kill
switch (deleted ads keep accruing for 28 days).

**Mitigation:** the `spend_authority` row with `SELECT … FOR UPDATE` before any activation or budget
increase; **hourly reconciliation of `committed` against Meta's actual sums, with drift >1% pausing all
ACTIVE campaigns**; every budget write passing a worst-case daily-and-weekly exposure validator; account
`spend_cap` as the Meta-side backstop (remember: applies only to spend *after* it is set, and needs a
scheduled `spend_cap_action=reset`); a native Automated Rule as a dead-man's switch that fires
server-side even when your infrastructure is down; and the **create-PAUSED-activate-last** state machine
that collapses all spend risk into one idempotent status flip.

### R3 — Silent no-delivery (unfunded / unsettled account)
**Likelihood: High — this will happen in month one.** **Blast radius: wasted generation spend plus a
corrupted learning corpus.**

Everything returns 200, insights are all zeros, the optimiser concludes the creative failed and
regenerates. The corpus then contains "this angle got zero conversions" rows that were never delivered.

**Mitigation:** the account-health preflight before every publish **and every optimiser decision**;
an explicit **"not eligible to deliver"** state that never updates a creative prior; and the
zero-delivery guardrail (ACTIVE 24h with `impressions == 0` → escalate). Also detect
`effective_status: PENDING_BILLING_INFO` explicitly — it is a stall with no error anywhere.

### R4 — Bad creative at scale (fidelity failure)
**Likelihood: Medium-High** — it is the #1 complaint against every AI creative vendor.
**Blast radius: wasted media, brand damage, client churn, and in the IP case a rights-holder complaint.**

**Mitigation, in cost order:**
- **The keyframe gate before paying for motion.** Rejecting a wrong logo at the keyframe costs ~3% of
  rejecting it at the clip.
- **Tier-1 compositing as the default product-fidelity strategy** — background-remove the real packshot,
  generate the scene *without* the product, harmonise, overlay.
- **Round-trip ASR on every voiceover** ($0.0002/check) — the only thing that catches a mangled brand
  name.
- **An independent trademark/logo detection gate** on every clip. Google's indemnity carve-out means
  trademark exposure in advertising is **never** covered.
- **Extra-logo detections are a HARD reject with no retry**, and a `dri_copyright`/`dri_counterfeit`
  disapproval **halts the entire creative lineage globally** and pages a human.
- **The per-asset provenance ledger** — `{generator, model_id, model_version, prompt, negative_prompt,
  seed, source_reference_assets[], licence_id, c2pa_manifest, generated_at, operator}`. When a
  rights-holder complaint lands this is the entire defence and the only way to find every other ad
  sharing the tainted lineage. Retain ≥2 years.

### R5 — Policy rejection loop stalls the system
**Likelihood: High** (rejections are routine). **Blast radius: the loop halts at 3am with no human on
call; repeated rejections escalate to R1.**

**Mitigation:** the mandatory pre-flight gate (deterministic lint → special-category classifier →
frame-level vision at ≥1fps with OCR fed back through the lint → LLM classifier quoting verbatim policy
clauses → landing-page gate → **Meta `validate_only` + `synchronous_ad_review`** → preview render +
vision pass). **Instrument the precision/recall of stages 1–4 against Meta's actual decisions
continuously** — without that you are guessing. Remediate by creating a **new ad in the same ad set**,
never by editing (editing resets learning). Cap at 2 attempts.

⚠ Two traps: `synchronous_ad_review` **silently no-ops without `validate_only`**; and
`validate_only` **does not evaluate your landing page**, so a creative can pass pre-flight and be
rejected 20 minutes later on destination grounds.

### R6 — Marketing API version deprecation
**Likelihood: Certain, twice a year.** **Blast radius: total write failure across all tenants until you
deploy.**

**Marketing API versions live ~12 months; Graph API versions live ~24.** Everyone plans for 24 and gets
caught. v26.0 also shipped **silent version auto-upgrade**: endpoints unaffected by a version bump are
upgraded transparently; endpoints that *did* change simply fail. The only signal is the
`X-Ad-Api-Version-Warning` header.

**Mitigation:** pin the version in **exactly one constant**, with a hard calendar alarm; log the
effective version on every response; **alert on `X-Ad-Api-Version-Warning`**; run a monthly job that
diffs the versions page and alerts ≥60 days before expiry; **consider disabling auto-upgrade** (App
Dashboard → Marketing API → Settings → Ads API Version Settings) so failures are loud rather than silent;
**never make unversioned calls** (they resolve to a value someone can change in a UI without a deploy);
and keep the recorded-cassette contract test suite refreshing weekly against a real test account so a
changed response *shape* fails the build.

### R7 — Token revocation / access loss
**Likelihood: Medium.** **Blast radius: one tenant (BISU revocation) or every tenant (DUC/Data Access
Renewal miss, or the 30-day inactivity downgrade).**

Clients revoke BISU tokens from Business Settings with **no webhook**. Missing the Data Use Checkup /
Data Access Renewal 60-day window disables the app and every client write **at once**. 30 days of
Marketing API inactivity downgrades your ad API access to Development.

**Mitigation:** weekly `debug_token` validation with a `credential_health` state per tenant
(`OK | DEGRADED | REVOKED`) that gates the pipeline; on `190`/`200`/`294` mark `REVOKED` and **stop all
workflows for that tenant immediately** — do not retry, you will just burn quota and inflate the error
rate, which per §2.4 shrinks your insights budget; a **weekly Marketing API heartbeat on every app,
including staging**; and a compliance calendar subsystem with a **named human owner**.

### R8 — Provider outage or model retirement
**Likelihood: Medium.** **Blast radius: generation stops; publishing and optimisation continue.**

Veo is **us-central1 only with no multi-region failover**, fixed 50 RPM, no batch lane.
`veo-3.1-generate-001` retires "November 17, 2026 or later."

**Mitigation:** the provider abstraction with a capability descriptor and per-model semaphore;
**model IDs as configuration, never constants**; shard across GCP projects rather than buying small
Provisioned Throughput orders (1–9 GSUs = a 2,000-second enforcement window, worse than pay-as-you-go);
a warm second provider (Seedream for statics) exercised weekly so the path is not theoretically
available and practically broken; and **content-addressed caching**, which turns an outage into a
degradation rather than a stop.

### R9 — Statistical self-harm (the age-confound and its cousins)
**Likelihood: High if unmitigated — it is the default behaviour.** **Blast radius: the system
systematically destroys its own best work while appearing to function.**

**Mitigation:** completeness-weighted exposure inside the posterior; the full decision-gate list; two
loops with two freshness contracts; `HOLD` as a first-class verdict; **two weeks of shadow mode before
launch**; and the self-scorecard (premature-kill rate <5%, learning-phase occupancy <30% of
ad-set-days, interval coverage ≈0.90).

### R10 — Legal exposure on generated content
**Likelihood: Low per ad, High across a portfolio over time.** **Blast radius: regulatory penalty +
client indemnity claim.**

Three distinct regimes:
- **EU AI Act Art. 50**, in force since 2 August 2026: deployers generating deepfakes must disclose
  *"at the latest at the time of the first interaction or exposure"* in a *"clear and distinguishable
  manner."* **Meta's own "AI info" label sits behind a three-dot menu and does not satisfy this.**
  Penalties up to €15M or 3% of worldwide turnover. → **For EU delivery, burn an in-creative disclosure**
  (first-frame supertitle or persistent caption) for any synthetic likeness of a real person or altered
  real footage.
- **FTC 16 CFR Part 465** (in force since 21 Oct 2024): civil penalties for disseminating fabricated
  testimonials, with AI-generated ones explicitly in scope. **A synthetic person recounting a personal
  product result is a fabricated testimonial regardless of Meta's approval.** → the non-overridable
  presenter-not-customer rule, plus an on-screen "Dramatization — AI-generated presenter" disclosure
  where it could read as a testimonial.
- **Rights in the output.** Google's indemnity covers only Vertex GA models on a paid account and
  **never covers trademark claims arising from use "in trade or commerce"** — i.e. never for
  advertising. BytePlus has no ownership clause at all. **Meta's Ad Creative Generative AI Terms
  `[OFFICIAL]`: *"Meta retains all rights that it otherwise possesses in Output generated by the Ad
  Creative AIs"* and *"Use or publication of Output outside of Meta's platforms is unauthorized and a
  violation of these Terms."*** → **Never use Meta's generative creative features if multi-channel is
  ever in scope, and tag any Meta-enhanced asset as Meta-platform-only in the asset store.**

Also: **never write copy whose claim depends on the footage being real** ("real customer",
"unscripted", "filmed on location"). An unremovable "AI info" label next to it converts a stylistic
choice into a deceptive-practices violation.

### R11 — Tech Provider liability and audit exposure
**Likelihood: Low.** **Blast radius: contractual and reputational; potentially termination of platform
access.**

Platform Terms §5.b: you must contractually bind your clients and *"you are responsible for their acts
and omissions."* §7.c: Meta may audit once a calendar year (more with a Necessary Condition) on **10
business days' notice**, requiring *"all necessary physical and remote access"*, and **you reimburse
Meta's costs if non-compliance is found.**

**Mitigation:** the client agreement with flow-downs; a **subprocessor register**; access logs for every
token decryption (CloudTrail records every KMS `Decrypt` with its encryption context — this is the
reason to use KMS, not the $0.52/mo); a working **tenant-purge job on day one** (§3.d.i.2 requires prompt
deletion on request, on discontinuation, or when Meta asks); a published `/security.txt` and a real
vulnerability contact (§6.a.i); and a data-flow diagram plus deletion evidence producible in 10 business
days.

### R12 — Cross-tenant learning is non-compliant
**Likelihood: Medium** (depends on legal reading). **Blast radius: the "compounding knowledge" pitch
has to be rewritten, and any shipped model has to be retrained.**

See §6.5. Developer Policy 10.7(b) and 10.7(g) read as a per-advertiser purpose limitation plus a hard
storage-isolation requirement. **Resolve this with counsel before building the cross-tenant model, not
after.**

### R13 — Lead PII breach (only once lead-gen ships)
**Likelihood: Low.** **Blast radius: GDPR/CCPA exposure plus total loss of client trust.**

`leads_retrieval` data includes names, phone numbers, emails and in some markets **national ID numbers**
(`ID_AR_DNI`, `ID_CPF`, `ID_CL_RUT`, `ID_CO_CC`, `ID_EC_CI`, `ID_PE_DNI`) for people who never heard of
you. That is a different SOC-2/GDPR conversation than "we store ad metrics." Note also that Meta plants
**synthetic honeypot leads** (`issues_info` bucket `lead_gen_honeypot`) and observes what you do with
them.

### R14 — Onboarding funnel collapse
**Likelihood: High.** **Blast radius: no revenue.**

Not a technical risk, but on the evidence the **most likely reason the business fails**. Ten human gates
(§4.1), several requiring credentials the buyer does not personally hold (DNS, Business Manager admin,
the company card).

**Mitigation:** ship the on-Meta destination path first (Instant Forms / click-to-message need none of
gates 7–10); make onboarding a product surface with per-gate API-read status; ship degraded modes so
first spend is never blocked on the last gate; and instrument time-to-first-ad as the primary business
metric.

---

## 10. Recommended architecture and phased build plan

### 10.1 The stack

| Concern | Choice | Why |
|---|---|---|
| **Orchestration** | **Temporal** (Cloud, Essentials) | Only engine here with unbounded durable sleep + dedupe on workflow id + signals for human-in-loop + **replay/time-skipping tests**, without a per-step billing model that punishes polling. You will ship code daily while ~10k workflows sit in a 7-day `sleep()`; patching/Worker Versioning is the only mature answer, and its failure mode (non-determinism error) is loud and safe. And **you can unit-test a 14-day workflow in 200ms**, which for a system that spends money on a timer is worth more than everything else combined. |
| **Language** | **TypeScript** for orchestration and API surface; **Python** for ML and video tooling | The Node Meta SDK is unusable (stuck at v24.0.1 on npm since 2025-11-21), so you are hand-rolling HTTP anyway — which makes TS's type system the asset. Python keeps `facebook-business` available as an oracle. |
| **Meta API access** | **Hand-rolled typed HTTP client**, with `facebook-python-business-sdk` v26.0.1 **vendored as a codegen source, not a runtime dependency** | Every rate-limit decision depends on response headers the SDKs bury (Airbyte had to *subclass* `FacebookAdsApi` just to read them). You need per-call-site version pinning during migrations, which is a class-level constant in the SDK. Write `scripts/gen-meta-types.ts` (~150 lines) that extracts every `class Field` and nested enum into TS union types — derived from Meta's own spec. |
| **Idempotency** | Four layers: deterministic intent key → intent ledger row → **AdLabel reconciliation** → Temporal workflow id | The Graph API has no idempotency key. All four are required; any one alone leaks. |
| **Storage** | **Cloudflare R2**, content-addressed by SHA-256 | $0 egress, and the `file_url` upload path makes every publish an egress event. |
| **Secrets** | **AWS KMS envelope encryption**, one CMK per region/env + per-tenant data keys, AAD bound to `tenant_id` | Platform Terms §6.a.iv is an explicit obligation. AAD binding is free and stops a leaked row decrypting in the wrong tenant's context. |
| **Metrics store** | **Postgres**, monthly-partitioned **append-only snapshots** keyed `(tenant, level, object_id, stat_date, attribution_setting, observed_at)` | Attribution restates for 28 days; "latest state" is a lie and destroys decision provenance. |
| **Rate limiting** | **Redis** token buckets keyed `rl:{ad_account_id}:{bucket}` | A per-process limiter is useless with 20 workers hitting one account. |
| **Isolation** | shared DB + `tenant_id` + **Postgres RLS** + per-tenant KMS data key + per-tier Temporal task queues | RLS is the backstop for the query you forget to filter — and here a cross-tenant leak means publishing advertiser A's creative to advertiser B's account. |

**Cost-aware alternative:** if the team is under three people and shipping speed dominates, **Inngest**
(free 50k executions, Pro from $99/mo, sleeps to 1 year, built-in idempotency) is a legitimate choice —
accept the **24-hour idempotency window** (insufficient as your *only* dedupe for multi-day sleeps) and
per-step billing. **Trigger.dev** if human-in-the-loop approval is the dominant feature;
`wait.createToken()`/`wait.forToken()` is the cleanest approval primitive of the five. **Do not choose
Step Functions** (every retry is a billed state transition, 25,000-event history cap, 256 KiB payloads)
for a polling-heavy pipeline.

**Non-negotiable Temporal rules:** activities are the *only* place I/O happens; **heartbeat long
activities carrying the byte offset** so a retry resumes rather than restarts (this composes exactly with
Meta's `upload_phase=transfer` protocol); **never sleep inside an activity for a rate limit** — throw
`RateLimited(seconds)` and sleep in the workflow; and `continue-as-new` the long-lived `CampaignWorkflow`
on a schedule, or an hourly-polling year-long campaign approaches the 51,200-event ceiling.

### 10.2 Workflow decomposition

```
CampaignWorkflow (per campaign, continue-as-new ~monthly)
├── CreativeGenerationWorkflow (per concept)      ← fan-out/fan-in over SHOTS from day one
│     ├── generateScript / angles                  5m,  retry 3
│     ├── keyframe per shot  ─┐ parallel
│     ├── keyframeGate (VLM+OCR+ΔE) ─┘             ← reject here, not after motion
│     ├── submitVideoJob per shot                  idempotent by (concept_id, shot_idx)
│     ├── poll (workflow sleeps 15s between)
│     ├── assembleRender                           30m, heartbeat 60s
│     └── uploadRenderToR2                         10m, retry 5
├── PublishWorkflow (per ad variant)  workflowId = "publish:<idem>"
│     ├── preflightPolicy (validate_only + synchronous_ad_review)
│     ├── ensureAdLabel
│     ├── uploadVideoToMeta                        chunked; heartbeat per chunk w/ offset
│     ├── pollVideoReady                           until status.video_status == 'ready'
│     ├── createCampaign/AdSet/Creative/Ad         all PAUSED
│     ├── verify (advantage_state_info, effective DOF spec diff, previews)
│     ├── [optional] signal wait: approval         race(condition, sleep('48h'))
│     └── activate                                 ← guarded by spend_authority
├── sleep('72h')
├── MeasurementWorkflow                            async insights, handle 'Job Skipped' → resubmit
└── decide → {SCALE | HOLD | KILL | EQUIVALENT | ITERATE}
```

**Shot-level parallelism is the difference between a 5-minute and a 20-minute ad, and retrofitting it
means rewriting assembly.** Build it in from day one.

### 10.3 Four runtime modes, enforced in the client — not in workflow code

| Mode | Generation | Meta writes | Money |
|---|---|---|---|
| `SIMULATE` | stubbed/cached | none (logged to the intent ledger only) | $0 |
| `VALIDATE` | real | `validate_only` only | generation only |
| **`STAGE`** | real | **real objects, always `status=PAUSED`, never activated** | generation only |
| `LIVE` | real | real, activation permitted | full |

Implement as a single `client.mode` that **refuses `status: ACTIVE` and refuses
`POST /{campaign_id} {status: ACTIVE}` unless `LIVE`**, and assert it in a test that enumerates every
mutation call site. Then no workflow author can accidentally spend money.

**`STAGE` is the highest-value mode**: it exercises the real API, real video encoding, real ad review
(with `synchronous_ad_review` you even get the verdict), and real object ids. The only thing it does not
do is start delivery.

**And it matters because the sandbox is nearly useless for this product:** no Insights, invisible in Ads
Manager, one per app. It validates request shape and permissions and nothing else.

### 10.4 The dependable staging path

1. A **real ad account you own**, funded, with `spend_cap` set to a small real number (the $100 minimum)
   as a hard backstop.
2. All CI/staging runs in `STAGE` mode → real PAUSED objects.
3. A nightly reaper that archives every staging object older than 24h, matched by an `env:staging`
   AdLabel.
4. **Exactly one weekly `LIVE` canary**: one ad, $5/day, activated, measured, killed. This is the only
   way to test the parts of the system that exist only when delivery happens — insights shape,
   attribution restatement, the decision loop.
5. **Recorded-cassette contract tests** including **headers** (they are part of the contract), refreshed
   by a weekly CI job against the real test account, failing the build when a response *shape* changes.
   Test these explicitly: `{"status":{"video_status":"processing"}}`; `async_status: "Job Skipped"`;
   `effective_status: PENDING_BILLING_INFO`; `effective_status: IN_PROCESS`; a batch response where
   sub-request 3 carries an error body under an outer HTTP 200; `613/5044001`; and an `id` above 2^53
   asserting no precision loss.

### 10.5 The phased plan

---

#### **Phase 0 — One real ad, on a real account. Weeks 0–2.**

**Goal:** a video generated by the pipeline, published through the API, delivering on a funded account
you own, at $5/day. Nothing else.

- Meta **business-type app**, connected to your own Business portfolio. **Path A** — Standard Access
  only, no App Review.
- Your own funded ad account + Page + Instagram, `spend_cap` at the $100 floor.
- Sandbox account for request-shape validation.
- Pin **v26.0** in one constant. `appsecret_proof` on every call, unconditionally. Turn on
  **Require App Secret** in App Settings → Advanced.
- Hand-rolled TS client: version pin, header parsing (all four rate-limit headers, including the
  per-sub-response headers on batches), the retry classification table, bigint-safe JSON parsing.
- Minimal publish path: video → poll ready → creative → ad, everything PAUSED → verify → activate.
- **Settle the §13 probe list.** The `OUTCOME_SALES` website-purchase tuple is the highest-risk
  unverified assumption in the entire corpus and it gates every ecommerce campaign you will ever
  publish.
- **Start the Full-tier clock immediately** — 500 calls in 15 days at <15% error rate is trivially
  achievable with sandbox + own-account traffic, and it is worth **~150×** the `ads_management` quota
  and 150× the point-score ceiling. Do not defer this.
- **In parallel, start Business Verification and prepare the App Review submission** for
  `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`,
  `pages_manage_ads` **and `leads_retrieval`**. Leads must be in the *first* submission, not phase two,
  because **you cannot retrieve leads at all in Development mode** — the entire lead-gen vertical is
  gated behind it. Remember: **≥1 successful call per permission within the 30 days before submitting**,
  or it is an automatic rejection.

**Exit criterion:** an ad you generated is delivering impressions on a real account, and you have a
screenshot of the insights row.

---

#### **Phase 1 — The creative factory and the publish machine. Weeks 2–6.**

- **ShotList IR**, content-addressed, versioned, with `params_hash` (cache key) and `content_sha256`
  (dedupe key) kept distinct. Canonicalise carefully — sorted keys, dropped nulls, fixed float
  precision, no timestamps — and **version the canonicaliser**, or your hit rate is 0%.
- Veo 3.1 Fast on Vertex, `storageUri` to your own GCS, `predictLongRunning` + `fetchPredictOperation`,
  `sampleCount` up to 4, download inside the polling loop (never a two-stage fetch — provider URLs
  expire).
- Keyframe stage + the **VLM/OCR/ΔE gate**. Tier-1 compositing as the default fidelity strategy.
- ffmpeg assembly with the three known-bad defaults fixed (`setsar=1`, two-pass `loudnorm` +
  `aresample=48000`, `+faststart`), libass captions, the safe-zone bbox detector, and the full ffprobe
  assertion set.
- **Idempotency: all four layers.** Intent ledger → AdLabel → `*bylabels` reconciliation → Temporal
  workflow id with `USE_EXISTING` + `ALLOW_DUPLICATE_FAILED_ONLY`.
- **Policy pre-flight pipeline**, ordered cheapest-first and fail-closed, terminating in
  `validate_only + synchronous_ad_review`. Log every stage's verdict against the eventual real review
  outcome from day one — **that precision/recall series is the core metric of the compliance system.**
- Review poller + bounded remediation (new ad in same ad set, max 2 attempts, `dri_*` halts the lineage).
- **Insights sync**: rolling 28-day append-only snapshots, `attribution_setting` in the PK,
  `attribution_regime` stamped, `raw` retained.
- The four runtime modes, enforced in the client.
- Cost ledger (`cost_event`) with `cost_per_published_ad` and
  `generation_cost_to_media_spend_ratio` views live.

**Exit criterion:** ten ads generated and published unattended on your own account, with zero duplicates,
zero Meta-noncompliant renders, and a complete cost-per-ad figure.

---

#### **Phase 2 — The autonomy loop, in shadow then live. Weeks 6–12.**

- Gamma–Poisson posteriors with the **completeness correction** `s_effective = spend × F(age)`.
- The decision-gate list, the expected-loss rule, `HOLD` and `EQUIVALENT` as first-class verdicts.
- The **weekly creative maintenance window** — all pauses and all launches batched.
- The daily pre-noon budget decision with every clamp (±20%, ≥minimum_budgets, ≤2/day, monotone
  high-water mark, skip when LEARNING).
- The creative attribute vector, emitted at generation time, encoded into the ad name, with the
  **forced-randomisation slice** scaled to budget.
- `spend_authority` + hourly drift reconciliation + all circuit breakers as **hard stops**.
- Native Meta ad rules as the dead-man's switch (≈5/account), plus one `TRIGGER` + `PING_ENDPOINT` rule
  per account. Store rule state as configuration-as-code and re-assert it — rules self-disable
  (`disable_error_code`) and entity-scoped rules silently expand their blast radius as you create
  objects.
- The GC/archival job (archive is the primitive; snapshot stats before transitioning).
- Webhooks: `ad_account`, `async_requests`, `ads_rules_engine`, `creative_fatigue`, `ad_recommendations`.
- **Two full weeks of SHADOW MODE** on a live account — every action logged, none executed — before
  flipping to LIVE.
- The self-scorecard instrumented from the first shadow day.

**Exit criterion:** shadow mode produces decisions a human operator agrees with, the premature-kill rate
is under 5%, and interval coverage is ≈0.90.

---

#### **Phase 3 — Multi-tenancy. Weeks 12–20 (gated by App Review, which started in Phase 0).**

- Facebook Login for Business configurations — **minimal, and separate configurations for optional
  capabilities**, because consent is all-or-nothing.
- `BisuTokenProvider` behind the same interface. **Granular per-client tokens** via
  `POST /{CLIENT_BUSINESS_ID}/system_user_access_tokens`.
- The onboarding **gate state machine** as a customer-facing checklist with per-gate API-read status,
  plus **degraded modes** so first spend is never blocked on the last gate.
- One Business Manager per client. Per-tenant KMS data keys, RLS, per-tier task queues, per-account rate
  buckets.
- `credential_health` state gating the pipeline; weekly `debug_token` validation.
- The **compliance calendar subsystem** with a named owner: Data Access Renewal, annual
  re-certification, the weekly Marketing API heartbeat.
- Tenant purge job, subprocessor register, `/security.txt`.
- **Fee/spend data model** satisfying Developer Policy **10.6 (effective 2027-02-03)**: Meta spend
  reportable separately from your fees, in Meta's own metric terminology, and separately from other
  publishers. Retrofitting this into a fee model is expensive; build it now.

---

#### **Phase 4 — Verticals and the destination. Weeks 20+.**

Ordered by expected value, which is **not** the order the existing research would suggest:

1. **Lead-gen / on-Meta destinations.** `POST /{page_id}/leadgen_forms`, the **`leadgen` webhook** (never
   polling — speed-to-lead is a performance lever the ad system controls), CRM delivery as a monitored
   SLO, and — critically — **a lead-quality feedback loop pushing a qualified/won signal back as an
   offline or CAPI event keyed to `lead_id`.** Without it the optimiser drives down the cost of
   worthless leads and the autonomy claim is hollow for this vertical. Note **forms cannot be deleted,
   only archived**, so name deterministically and reuse.
2. **The destination as a first-class generated artifact.** A `PageSpec` sharing one `Offer` object with
   the creative, on a **tenant-owned** domain (client CNAMEs `go.clientbrand.com` to your edge, verified
   by *their* business). Plus the landing-page gate: fetch each URL twice (residential-like egress in
   the target geo + datacentre IP, desktop + mobile UA), assert 200 within ~5s, no
   `Content-Disposition: attachment`, no off-domain redirect, ad keywords present in the rendered DOM,
   privacy/contact links present, and **byte-similarity above a threshold between the two fetches —
   divergence is accidental cloaking.** Re-run weekly on every live ad; store HTML + screenshot as appeal
   evidence.
3. **Catalogue commerce**, if ecommerce is in scope — as a **second, parallel pipeline**, not a variant
   of the first. Different creative shape (`template_data`, product-set-driven), different levers (feed
   quality, product-set segmentation, `da_display_settings`), and a brutal rate limit:
   **`catalog_batch = 200 + 200 × log2(unique users)` per account per hour**, so a 50k-SKU store must go
   through scheduled **feeds**, not the batch API. **The correct division of labour: Meta's catalogue
   engine owns retargeting and bottom-funnel; your generated video owns prospecting and new-angle
   discovery.** Frame it that way rather than competing with a free, better system on its home turf.
4. **Click-to-WhatsApp**, if non-US SMB is a target market. For local service businesses in most of the
   world, CTWA is *the* dominant format, and it appears **twice across 17,200 lines** of research. It
   needs its own dossier before it needs code.

---

## 11. Open questions the human must answer

These are product-owner decisions, not engineering ones. An engineer who picks a default here has made
a business decision by accident.

### 11.1 Which advertiser archetype are we for?

The research implicitly assumes **one archetype**: a DTC ecommerce business with a website, a purchase-
history pixel, a funded account and a Page. Every objective example is `OUTCOME_SALES` + `WEBSITE` +
`PURCHASE`. **The two largest real markets for "give me three inputs and run my ads" — SMB lead-gen and
catalogue ecommerce — are each a materially different product**, with a different onboarding, a
different measurement substrate, and a different creative pipeline.

**This choice cascades into everything.** Pick one. The evidence mildly favours **SMB lead-gen with
on-Meta destinations first**, because it is the only path that is genuinely autonomous without domain
verification, a pixel, or AEM — but it demands `leads_retrieval` in the first App Review and a
lead-quality loop, and it puts you in the PII business.

### 11.2 Who eats an overspend?

Meta's liability is capped at **$100**. If the loop overspends a client by $9,000 — mechanically possible
given the 175%-of-daily-high-water-mark ceiling — the loss is allocated **by your contract alone**.
Do you offer a spend guarantee? A credit policy? A hard per-account cap that degrades service rather than
risking overspend? **Decide in writing before the first customer, not after the first incident.**

### 11.3 What is the pricing meter?

Percentage-of-spend aligns you with Meta and against your client's margin, contradicting the product's
own differentiation story, and pulls toward agency/broker regulation in several jurisdictions. Flat SaaS
+ a creative-volume component is safer and matches the cost structure (§8.5). But it caps upside on
large accounts. **This is a positioning decision, and it also determines whether §8's tiering is the
product or just an internal cost model.**

### 11.4 Do we ever train across tenants?

Developer Policy 10.7(b) and 10.7(g) read as a per-advertiser purpose limitation plus a hard
storage-isolation requirement. A model trained on tenant A's Meta performance data and used to optimise
tenant B is **presumptively non-compliant** (§6.5). **This needs counsel, and the answer determines
whether "compounding cross-account knowledge" is in the pitch deck.** If the answer is no, the safe
design — per-tenant models plus priors derived from your own randomised design choices and published
benchmarks rather than from Meta's reported numbers — still works, but the marketing story is weaker
and you should know that now.

### 11.5 Is it ethical to run a deliberately worse policy on paying accounts?

Fleet-level account randomisation (118 accounts/arm to detect a 20% improvement) is the only design that
produces a marketing-grade causal claim. It requires running the control policy — deliberately worse, if
your product works — on customers who are paying for the treatment. **This is an ethics and ToS question
that must be resolved before the experiment is designed, not after it is running.** The fallback (paired
switchbacks, 15 account-week pairs for 20%) is defensible and much less fraught; decide whether the
stronger claim is worth the exposure.

### 11.6 How much autonomy do we actually sell on day one?

There is a real spectrum: `STAGE`-only with a human clicking activate (safe, honest, and exactly what
every competitor already does) → activate-within-envelope → full autonomy including creative refresh and
budget moves. **The trust wedge argues for shipping with a visible, explicit, reversible go-live
transition and earning autonomy per-account over time**, rather than claiming full autonomy on day one
and losing a client to one bad ad. But "we're autonomous" is the entire differentiation. **Where does
the default sit, and what earns an account a promotion?**

### 11.7 Do we ever touch Special Ad Categories or regulated verticals?

Housing / Employment / Financial Products carry server-enforced targeting restrictions, a
**non-API-clearable** `2859024` certification gate, and heightened rejection risk.
**SIEP should be a hard block** — the authorization is manual and multi-day, the EU prohibits political
ads outright since 2025-10-06, and there is a US blackout in the final week before the Nov 2026
midterms. Health, weight-loss, cosmetic and supplement verticals require human review of before/after
templates and are hard-blocked if the subject is AI-generated. **Which verticals are we willing to
underwrite, and which do we refuse at signup?**

### 11.8 Do we ever use Meta's own generative creative features?

Meta's Ad Creative Generative AI Terms `[OFFICIAL]`: *"Meta retains all rights that it otherwise
possesses in Output"* and *"Use or publication of Output outside of Meta's platforms is unauthorized."*
**If multi-channel is ever in scope, the answer is no** — and every asset must be tagged with whether
Meta touched it. This also settles the `degrees_of_freedom_spec` question: uniform OPT_OUT is not just an
experimental-hygiene choice, it is a rights choice.

### 11.9 What is the human escalation contract?

An unattended system generates escalations. Who is on the pager at 3am — you, or the client? What is the
SLA on a `dri_copyright` halt? On a payment failure? **The answer determines whether this is a software
company or a managed service**, and it determines the cost structure in §8 far more than any model
price.

### 11.10 What happens to the client's ads if we go away?

You publish into *their* ad account. On termination the objects remain but the loop stops, budgets sit
frozen at their last written value, and no one is watching the disapproval poller. **Define the wind-down
behaviour** — pause everything, or hand over a documented static state — and put it in the contract.
Platform Terms §3.d.i.2 requires prompt deletion of Platform Data on discontinuation anyway, so the
mechanism has to exist regardless.

---

## 12. Adjudication log

Where the dossiers contradict each other or themselves. Each entry states the ruling and the reason.

| # | Conflict | **Ruling** | Reason |
|---|---|---|---|
| 1 | **Object ceilings: 5,000 (foundations, policy) vs 6,000 (gaps)** | **6,000** non-archived per type on a regular account; 10,000 ad sets/campaigns and 50,000 ads on bulk; **100,000 archived per type as a separate bucket** | The 5,000 figure was explicitly flagged verified-secondary; the 6,000 table is `[OFFICIAL]` from the AdAccount reference. The separate archive bucket is the actionable part: **archive is the GC primitive.** |
| 2 | **Marketing API v23.0: expired 2026-06-09 vs available to 2027-10-08** | **Both are right — they are different clocks.** Graph API v23.0 runs to 2027-10-08; **Marketing** API v23.0 ended 2026-06-09 | The dossiers conflated two changelogs. Graph ≈24 months, Marketing ≈12. **Operational rule: budget a forced Marketing API migration every ~6 months and death at ~12, regardless of what the Graph table says.** |
| 3 | **Unversioned calls resolve to the oldest non-expired version** | **False.** An unversioned call uses the version set in App Dashboard → Settings → Advanced | The oldest-usable fallback applies only *after* a version expires. **Never make unversioned calls** — the behaviour is controlled by a UI field, not your deploy. |
| 4 | **ODAX mapping: `PRODUCT_CATALOG_SALES → OUTCOME_SALES` row** | **Not confirmed. De-flagged from "VERBATIM."** `OUTCOME_SALES` **never appears** as a target objective anywhere in the Objective Mapping table, on either the `/docs/` page or the `/documentation/ads-commerce/` mirror | This is a documentation hole, not a retrieval artifact. **The inferred website-purchase tuple (`OUTCOME_SALES` + `OFFSITE_CONVERSIONS` + `IMPRESSIONS` + `{pixel_id, custom_event_type: PURCHASE}`) is the highest-risk unverified assumption in the entire corpus** and must be settled by a live create call in week one (§13). |
| 5 | **Objective Mapping table only reachable via the `/documentation/ads-commerce/` mirror** | **False.** It is present on the ordinary `/docs/marketing-api/reference/ad-campaign-group` page | Do not build tooling around the mirror URL. |
| 6 | **EU DSA: `dsa_beneficiary` required (optionally `dsa_payor`)** | **BOTH are required.** *"For ad sets targeting the EU and/or associated territories, the dsa_payor and dsa_beneficiary fields are required."* | And **neither is flagged `[required]` in the parameter table** — the requirement is prose only, so a schema-driven client omits them silently and fails at publish. Account-level defaults exist at `AdAccount.default_dsa_beneficiary` / `default_dsa_payor`. |
| 7 | **Daily budget overspend: 25% vs 75%** | **A live doc conflict Meta has not resolved.** The v24.0 changelog says 75%; the budgets guide still says 25% | **Model the worst case (75%, and a 175% ceiling anchored to the day's high-water mark).** Separately: the "weekly cap is 7× daily" figure appears on **no** developers.facebook.com page — it is a widely repeated secondary claim and **must not be encoded as a documented invariant.** |
| 8 | **Zero-decimal currencies: 10 vs 11** | **Eleven.** CLP, COP, **CRC**, HUF, IDR, ISK, JPY, KRW, PYG, TWD, VND | The omission of CRC is a live money bug — a `/100` on a CRC account misstates every budget by 100×. **Better than either list: read `currency` off the ad account and look the offset up.** |
| 9 | **Seedance concurrency: 3 vs 10** | **Per-model, not per-account.** 10 on Seedance 1.x (the recommended workhorse), 3 on Dreamina 2.x for individual accounts, **1 at 4K on `dreamina-seedance-2-0-260128`** | The "3 concurrent / ~360 clips/hour" figure understated the recommended pipeline's ceiling by ~3.3×. Drive a **per-model semaphore from a capability descriptor.** The 4K concurrency of 1 is by far the tighter constraint and was originally missed entirely. |
| 10 | **Recommendation types: "44+" vs 37** | **37 documented types, 14 applyable via POST** | Also: **`type` is returned on ad-account requests only; `recommendation_name` on business-level requests only.** A portfolio-wide collector keying its apply-whitelist off `type` matches nothing. |
| 11 | **Automated rules: UNPAUSE rules "silently do nothing" because of an implicit ACTIVE filter** | **Refuted, and the real risk is inverted.** There are **two** implicit defaults: `IN ['ACTIVE','PENDING_REVIEW']` for execution types acting on active objects, and `NOT_IN ['DELETED','ARCHIVED']` for those that do not — with **UNPAUSE named explicitly** as the latter case | So UNPAUSE rules **do** see paused objects, and the real danger is that one **reactivates ads your loop deliberately paused** (PAUSED is neither DELETED nor ARCHIVED). **Never ship an UNPAUSE rule.** Separately: **trigger-rule UNPAUSE is unverified** — the trigger guide demonstrates only PING_ENDPOINT, NOTIFICATION and PAUSE. |
| 12 | **Ad video bitrate: 100 Mbps vs 25 Mbps max** | **25 Mbps VBR maximum**, per the primary placement spec | Also: the **moov-atom / no-edit-lists / 4:2:0 / closed-GOP** block is the **Instagram organic** publishing spec, not the ad spec (the same table gives 300MB/100MB against the ads guide's 4GB). **Comply with the strict intersection anyway** — it eliminates the dominant class of Meta error `352`. Three constraints from that table were missed originally: **23–60 FPS, max 1920 horizontal pixels, 3s min / 15min max duration.** |
| 13 | **AI auto-detection "live since 2026-06-01"** | **Announced, not confirmed live** — the original claim was an over-read of a page timestamp | **Design as if it is live.** Assume every delivered asset is detectably AI-generated (SynthID survives all your post-processing) and that the "AI info" label is applied. The safe design is identical either way, and it costs nothing. |
| 14 | **Blanket mandatory AI disclosure with a strike ladder** | **False.** Advertiser self-disclosure is required **only** for SIEP ads, in five enumerated scenarios, via `authorization_category = POLITICAL_WITH_DIGITALLY_CREATED_MEDIA` | A large body of 2026 SEO content claims otherwise with **no primary source** and contradicts Meta's docs. **But note the narrower obligation that is real:** Meta's GenAI Terms say you *"must not misrepresent Output as human-generated when it is not"* — for Meta-generated Output specifically. |
| 15 | **`creative_features_spec` defaults: `description_automation` and `inline_comment` default OPT_IN** | **False. Only `adapt_to_placement` is documented as default opt-in.** | And the `AdCreativeFeaturesSpec` node reference is **not a complete inventory** — seven shipping features are absent from it (`enhance_cta`, `image_brightness_and_contrast`, `image_text_translation`, `image_uncrop`, `video_auto_crop`, `video_filtering`, `video_uncrop`), two of them AI-generating. **Do not generate a feature enum from the reference page.** Send an exhaustive explicit OPT_OUT and **diff the read-back** — Meta silently strips ineligible keys, so write ≠ read. |
| 16 | **Async is mandatory for the opt-in-gated breakdowns** | **False.** Opt-in gates **both** sync and async; async merely preserves full history **after** opt-in | And a missed constraint: async jobs on those breakdowns are throttled to **min(10, number_of_ad_groups) per 24 hours** — on a 4-ad-set account that is 4 jobs/day, not 10. |
| 17 | **`actions[]` roll-up mechanism and `purchase_roas` units** | **Downgraded to `[SECONDARY]`.** The `AdsActionStats` reference never states that `omni_*` aggregates other action types, and does not list a bare `purchase` action_type at all | **The engineering advice is unchanged and still correct: pick exactly one `action_type` per KPI and hard-code it.** Also six value keys were missing: `1d_ev_all_conversions`, `1d_ev_first_conversion`, `1d/7d/28d_sequenced`, `custom`, `promoted_product_set_result`. |
| 18 | **Marketing API Access Tier rename date: 2026-05-05 vs 2026-05-04** | **2026-05-04** | Same changelog entry also renamed the *feature* from "Ads Management Standard Access" to "Marketing API Access Tier". The **100 QPS create/edit ceiling** was labelled verified-secondary and is in fact **official and verbatim** on the rate-limiting page. |
| 19 | **Does Meta ship an official MCP server?** | **Yes — `https://mcp.facebook.com/ads`, with write tools.** Opened to Claude/ChatGPT 2026-04-29, to any developer app 2026-07-16 | But **not usable as our publish path**: it is limited availability (error 10 / HTTP 403 if unenrolled), lives on a different host (`ads-api.facebook.com`) pinned to **v25.0**, and its `ads_create_creative` supports **single-image link creatives only** — no video, no carousel, no `creative_features_spec`. It is a competitive fact, not an implementation option. |
| 20 | **Delivery Estimate removal: "removed in v26.0" vs "removed 2026-10-27"** | **Unresolved, and it does not matter.** | `daily_outcomes_curve`, `budget_guardrail` and `estimate_dau` are going or gone with **no replacement API**. **Build your own budget-response model now**, from historical `/insights` plus deliberately randomised ±15% budget perturbations. |
| 21 | **`personGeneration` enums on the Gemini Developer API** | **The value is fixed BY GENERATION MODE, globally — not a free choice, and not regional.** Veo 3.1 text-to-video and extension = `allow_all` only; image-to-video, interpolation and reference images = `allow_adult` only | Vertex is correct as originally stated (`allow_adult` default, `disallow`). The `dont_allow` default appears **only** inside the EU/UK/CH/MENA regional restriction. Getting this wrong is a hard request failure on every i2v call, which is our primary path. |
| 22 | **Ad-account ceilings vs "5,000 ads" in the policy dossier** | Superseded by #1. | |
| 23 | **`architecture-stack.md` summary reads "test" / "a"** | **The summary is a placeholder; the 1,350-line file is real and load-bearing.** | It is the source for the SDK state, the orchestrator comparison, the idempotency scheme, the storage cost model and the KMS design in §10. Anyone reading only the summaries would have missed all of it. |

**Two things the corpus is internally consistent about and that are worth restating because they are
counterintuitive:**

- **Sandbox cannot test the thing you care about.** No Insights, no delivery, invisible in Ads Manager,
  one per app. The optimisation loop's test environment is a real funded account in `STAGE` mode plus a
  weekly $5 canary.
- **`level=ad`, one creative per ad, is not a preference — it is forced.** Asset-level breakdowns will
  *never* return ROAS, retention or ranking diagnostics, and Meta's own asset selection confounds them.
  This single constraint rules out Dynamic Creative and Flexible Ad Format for the generated-video
  pipeline, and it is the reason the ad object (not the asset) is the unit of the bandit.

---

## 13. The empirical probe list — week one

Every item here is `[UNVERIFIED]` and load-bearing. Each is a single API call on a real account. Do all
of them before Phase 1 code is written.

| # | Probe | What it settles | Blast radius if wrong |
|---|---|---|---|
| **1** | **Create a live `OUTCOME_SALES` campaign with `optimization_goal=OFFSITE_CONVERSIONS`, `billing_event=IMPRESSIONS`, `promoted_object={pixel_id, custom_event_type:PURCHASE}`, `destination_type` omitted** | The website-purchase tuple. **There is no documented ODAX mapping row for it at all.** | **Every ecommerce campaign the platform will ever publish.** Highest-risk assumption in the corpus. |
| 2 | Create an `OUTCOME_TRAFFIC` ad set **omitting** `destination_type` vs sending `WEBSITE` | `OUTCOME_TRAFFIC` does not list `WEBSITE` in the legality table | Every traffic campaign |
| 3 | `POST /act_{id}/ads` with `execution_options=['validate_only','synchronous_ad_review','include_recommendations']` on a known-bad creative | Whether the 2016 `validate_only`+`include_recommendations` contract holds at v26.0, and what the pre-flight actually catches | The entire compliance gate's value |
| 4 | `GET /{ad_id}?fields=ad_review_feedback` on a disapproved ad | The 2026 shape of the field, and the reason-code namespace | The remediation loop |
| 5 | Set `is_ai_generated: true` on `POST /act_{id}/advideos` and observe delivery | Whether it triggers a label, affects reach, or is policy-required. **Directly load-bearing for a fully generative platform.** | Policy posture and possibly reach |
| 6 | `GET /act_{id}/ads_volume` on a new low-spend account | `limit_on_ads_running_or_in_review` and the spend→ad-count tier (Meta publishes no table) | Cold-start creative volume |
| 7 | `GET /{form_id}/leads` rate limit on a brand-new Page | The formula `200 × 24 × leads_in_90d` gives a new Page **zero quota**. There is presumably a floor; Meta does not state one | Whether lead-gen works at all on day one |
| 8 | Attempt a trivial custom-audience read/create | Whether `200/1870090` (Custom Audience ToS) fires — the cheap pre-flight probe | Onboarding gate detection |
| 9 | `GET /debug_token` on a fresh BISU token | Whether `ads_api_access_tier` now emits `limited_access`/`full_access` instead of `development_access`/`standard_access` | Tier detection logic |
| 10 | Create a campaign, read back `advantage_state_info` with and without a single `publisher_platforms` field | Confirms the three-lever model and that one leaked field flips the whole state to DISABLED | The default publish shape |
| 11 | Whether video creative is supported in Advantage+ catalogue ads | Decides whether the video pipeline can feed the catalogue surface at all | Phase 4 scope |
| 12 | `conversion_domain` exact requirements (the docs page 404s) | Which objectives require it, the expected format (eTLD+1?), and the error on omission | Every website campaign's create call |
| 13 | Whether client-portfolio BISU tokens count against the "10 system users on Full tier" cap | Multi-tenancy identity design above 10 tenants | Phase 3 architecture |
| 14 | A fixed 50-prompt suite across Veo 3.1 Fast, Veo 3.1 Lite and Seedance 1-0-pro-fast, scored by the same VLM gate | **Effective cost per *usable* clip.** A $0.05 model at 20% usable costs $0.25/usable — worse than a $0.20 model at 90% | The entire provider decision in §5 |

---

## Source dossiers

| File | Lines | What it is authoritative for |
|---|---|---|
| `meta-api-foundations.md` | 895 | Auth, access tiers, tokens, rate limits, Developer Policy 10.x |
| `meta-campaign-publishing.md` | 1,041 | Object model, ODAX legality matrix, Advantage+ three levers, publish state machine |
| `meta-video-creative.md` | 1,211 | Upload protocol, `object_story_spec`, `asset_feed_spec`, placement specs, safe zones, `degrees_of_freedom_spec` |
| `meta-insights-measurement.md` | 1,101 | Insights API, attribution regimes, learning phase, CAPI, insights rate limits |
| `meta-optimization-controls.md` | 1,184 | Ad Rules Engine, budget mechanics, CBO, ad studies, Opportunity Score & Recommendations |
| `meta-policy-compliance.md` | 946 | Advertising Standards taxonomy, review mechanics, AI disclosure, account safety, appeals |
| `meta-native-automation.md` | 1,124 | Advantage+ unification, Meta's free AI surface, MCP server, ranking stack |
| `architecture-stack.md` | 1,350 | SDK state, orchestrator choice, idempotency, data model, storage/KMS costs, testing |
| `autonomous-optimization-science.md` | 1,671 | Bandits, delayed feedback, decision rules, sample sizes, hierarchical models, budget allocation |
| `performance-creative-playbook.md` | 1,956 | The power law, creative genome, formats, hook tactics, fatigue, testing tiers |
| `creative-production-pipeline.md` | 1,285 | ShotList IR, keyframe gate, ffmpeg recipes, QA gates, cost/latency per ad |
| `video-gen-google-veo.md` | 1,020 | Veo/Gemini capabilities, pricing, quotas, indemnity, SynthID/C2PA, refusal codes |
| `video-gen-byteplus-seedance.md` | 899 | Seedance/Seedream API, verified billing formula, per-model limits, commercial rights |
| `competitive-landscape.md` | 791 | Market map, who closes the loop, complaint corpus, Meta's encroachment |
| `gaps-and-missing-pieces.md` | 622 | Destination, lead handling, funding, onboarding gates, liability chain, cold start |
| `live-provider-probe.md` | 139 | Live model catalogue and aspect-ratio matrix — **supersedes any model-existence claim elsewhere** |

**Total: ~17,200 lines.** Where this synthesis and a dossier disagree, §12 says which wins and why.
Where neither is verified, §13 says who has to go find out.
