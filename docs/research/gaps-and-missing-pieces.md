# Gaps & Missing Pieces — completeness critique of the research programme

**Date:** 2026-09-02
**Role:** completeness critic. This document is deliberately adversarial toward the existing dossier set.
**Method note:** this session's `WebSearch` budget was already exhausted (200/200) before work began, so
everything below comes from direct `WebFetch` retrieval of Meta's own documentation and legal terms.
`www.facebook.com/legal/*` is JS-rendered and returns a shell; `mbasic.facebook.com/legal/*` serves the
real text and is the workaround used here. `www.facebook.com/ads/library/api` returns **HTTP 403** to
automated fetches and could not be read.

Confidence tags used below: `[OFFICIAL]` quoted from a Meta primary source retrieved this session ·
`[INFERRED]` reasoned from an official source but not stated by it · `[UNVERIFIED]` needs a live probe.

---

## 0. The structural criticism, before the individual gaps

The eleven existing dossiers total ~16,600 lines. They are exceptionally deep on **how to get an ad
object into Meta's system and measure it**, and they are close to empty on **everything on either side
of that**. Specifically:

| Stage | Coverage |
|---|---|
| Brand → concept | thin (playbook covers *what performs*, not *how the system learns a brand it has never seen*) |
| Concept → video | excellent (3 dossiers) |
| Video → live ad | excellent (4 dossiers) |
| Ad → measurement → next ad | excellent (2 dossiers) |
| **Click → destination → conversion** | **absent** |
| **Conversion → lead → customer** | **absent** |
| **Advertiser → onboarded, funded, verified account** | **absent** |
| **Who pays when it goes wrong** | **absent** |

Four framing problems follow from that:

1. **The research implicitly assumes one advertiser archetype**: an ecommerce/DTC business that already
   has a website, a working pixel with purchase history, a funded ad account, and a Facebook Page. Every
   objective example in `meta-campaign-publishing.md` is `OUTCOME_SALES` + `WEBSITE` + `PURCHASE`. The
   two largest real markets for "give me three inputs and run my ads" — **local/SMB service businesses
   (lead gen)** and **catalogue ecommerce** — are each a materially different product, and neither has a
   dossier.
2. **"The human gives only a few inputs" is not achievable on day one and the research does not say so.**
   There is a hard floor of manual, UI-only, sometimes multi-day gates (§4). The honest product framing is
   *"a few inputs per campaign, after a one-time assisted setup that takes days and requires the client's
   credit card, DNS access, and legal signature."*
3. **Autonomy is scoped as an optimisation problem when the expensive failures are operational.**
   `autonomous-optimization-science.md` is a genuinely strong treatment of delayed-feedback bandits. But
   the things that will actually cost money in month one are: an ad account with no funding source that
   returns HTTP 200 on every write and delivers nothing (§3), a budget written in the wrong currency
   exponent (§8.6), a non-idempotent retry that publishes the same ad twice (§8.5), and a landing page
   that does not match the ad (§1).
4. **One load-bearing number in the existing set is wrong.** See §9.1.

---

## 1. GAP — The destination is unowned. The ad is half the funnel.

### Why it matters
Meta charges for the click. Everything after it determines whether the click was worth buying, and
`meta-policy-compliance.md` already establishes that Meta **reviews the landing page as part of the ad**
and enforces a match rule: *"The products and services promoted in an ad must match those promoted on the
landing page."* No dossier covers generating, hosting, verifying, or varying a destination. An autonomous
creative generator that produces 40 angles per week pointed at one static homepage is systematically
violating the match rule and systematically wasting the clicks it buys.

### What I found

**Domain verification is a hard, human, DNS-level gate, and it is exclusive.**
Meta's Domain Verification documentation: *"Domain Verification provides a way for you to claim ownership
of your domain in Business Manager,"* requiring *"the ability to upload HTML files to the web root
directory or the ability to edit DNS TXT records."* `[OFFICIAL]`
<https://developers.facebook.com/docs/sharing/domain-verification>
There is **no API to verify a domain** — the retrieved page documents no endpoint. `[INFERRED from absence]`

**Business Tools Terms forbid the obvious shortcut of a shared platform domain.**
*"You (or partners acting on your behalf) may not place pixels associated with your Business Manager or ad
account on websites that you do not own."* `[OFFICIAL]`
<https://www.facebook.com/legal/terms/businesstools> (read via `mbasic.facebook.com`)
So hosting every tenant's landing page on `lp.ourplatform.com` and firing each tenant's pixel from it is
a terms violation on its face, and additionally collides with domain verification being claimable by only
one business.

**Conversions are domain-scoped.** `conversion_domain` is a required field on the Ad node
(`meta-campaign-publishing.md`), and the `traffic_quality` bucket in `issues_info`
(`meta-policy-compliance.md`) is a destination-quality signal that can suppress delivery without a
disapproval.

**There are on-Meta destinations that make the whole problem disappear.** `destination_type: ON_AD`
(Instant Forms, requires `OUTCOME_LEADS`) and the Messenger/WhatsApp/Instagram-Direct destinations remove
the website from the loop entirely. `[OFFICIAL]` — destination_type enum, `meta-campaign-publishing.md`
§ destination_type. This is how most local SMB advertisers should be run and no dossier proposes it.

### Design consequence
- **The destination is a first-class generated artefact, versioned alongside the creative, and they share
  one `Offer` object.** A creative angle change that is not reflected on the page is a policy violation,
  not just a conversion-rate loss. The ShotList/creative cache design in
  `creative-production-pipeline.md` needs a sibling `PageSpec` keyed by the same offer hash.
- **Landing pages must live on a tenant-owned domain or subdomain** (client CNAMEs `go.clientbrand.com`
  to your edge), verified by *the client's* business, not yours. Add "DNS record" to the onboarding
  checklist and accept that it blocks conversion optimisation until done.
- **Ship the on-Meta destination path first.** Instant Forms and click-to-message require no website, no
  domain verification, no pixel, and no AEM — which means the product can be genuinely autonomous for
  SMB lead-gen months before it can be for a website advertiser.
- **The landing page is a variable in every experiment.** Changing it mid-test confounds the creative
  bandit in `autonomous-optimization-science.md`. Freeze the page for the life of a creative cohort or
  log the page version as a covariate.

### Open
- Whether Aggregated Event Measurement still requires domain verification and still caps at 8 prioritised
  events per domain in 2026 — `/docs/marketing-api/aggregated-event-measurement` and
  `/docs/marketing-api/conversions-api/aggregated-event-measurement` both **404**. This decides whether
  the pipeline must manage an event priority list per tenant domain. `[UNVERIFIED]`
- Meta's ad-review crawler User-Agent / IP ranges — still unpublished (already flagged in
  `meta-policy-compliance.md`). Generated pages behind a WAF or with JS-only content are an accidental
  cloaking risk.

---

## 2. GAP — Lead handling is an entire product, not an integration

### Why it matters
For local/SMB service advertisers, "the conversion" is a lead, and **lead quality is uncorrelated with
cost per lead**. An autonomous system optimising CPL without a lead-quality feedback loop will
enthusiastically drive the cost of worthless leads down. This is the single biggest omission for the
SMB market and nothing in eleven dossiers addresses it.

### What I found (all `[OFFICIAL]`)

**Form creation** — `POST /{page_id}/leadgen_forms`
<https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/create>
- Required: `access_token` (Page token), `name`, `questions` (array of `{type, key}`)
- Optional and performance-relevant: `is_optimized_for_quality` (adds a review/confirm step — the
  higher-intent form), `block_display_for_non_targeted_viewer`, `tracking_parameters`,
  `thank_you_page{body,title,button_type,button_text}`, `upload_gated_file`, `inline_context`
- Question types: `FULL_NAME`, `EMAIL`, `PHONE`, `CUSTOM`, `DATE_TIME`, `STORE_LOOKUP`, plus national ID
  types `ID_AR_DNI`, `ID_CPF`, `ID_CL_RUT`, `ID_CO_CC`, `ID_EC_CI`, `ID_PE_DNI`
- **Forms cannot be deleted:** *"You can only archive a lead form since deleting is not supported."*
  An archived form *"can't be used in an ad, attempting to do so can generate an error via the API."*
  Reactivate by setting `status` to `ACTIVE`.

**Lead retrieval** — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving>
- `GET /{form_id}/leads`, `GET /{ad_id}/leads`, `GET /{lead_id}`,
  `GET /{leadgen_id}?fields=custom_disclaimer_responses`,
  `GET /ads/lead_gen/export_csv/?id={form_id}&type=form`
- Webhook: subscribe to the **`leadgen`** field on the Page object. Payload carries `leadgen_id`,
  `page_id`, `form_id`, `adgroup_id`, `ad_id`, `created_time` — note it carries **no PII**; you must
  then `GET /{lead_id}` with a Page token.
- Rate limit, verbatim: *"200 multiplied by 24 then multiplied by the number of leads created in the past
  90 days for a Facebook Page."*
- Permissions for full lead + ad-level data: `ads_management`, **`leads_retrieval`**, `pages_show_list`,
  `pages_read_engagement`, `pages_manage_ads` (+ `pages_manage_metadata` for webhooks).
- **Development-mode apps cannot retrieve leads at all:** *"You can't retrieve leads if your app is in
  Development mode."* Only leads submitted by people with a role on the app are readable in dev.

**Legal framing** — `leads_retrieval` is Business-Tool data. Business Tools Terms:
*"you (and any data provider that you may use) have all of the necessary rights and permissions and a
lawful basis"*, must give *"robust and sufficiently prominent notice"*, and, for a tool acting on a
client's behalf, *"you have the authority as agent to such third party to use, share, and process such
data on its behalf and bind such third party to these Business Tools Terms."* `[OFFICIAL]`

**Meta actively tests you.** `meta-policy-compliance.md` already records an `issues_info` bucket named
`lead_gen_honeypot` — Meta plants synthetic leads and observes what you do with them.

### Design consequence
- **`leads_retrieval` must be in the very first App Review submission,** not a phase-2 item. You cannot
  build or test lead retrieval in Development mode, so the whole lead-gen vertical is gated behind
  Advanced Access. This changes the App Review critical path described in `meta-api-foundations.md`.
- **Speed-to-lead is a performance lever the ad system controls.** Use the `leadgen` webhook, not
  polling; treat delivery latency to the client's CRM/phone as a monitored SLO. Polling `/{form_id}/leads`
  as the primary path is a design error.
- **Close the quality loop or don't do lead gen.** Push a qualified/won signal back as an offline or CAPI
  event keyed to `lead_id`, so the optimiser and the creative bandit score *qualified* leads. Without it,
  the "learning loop" for lead-gen advertisers optimises the wrong objective and the whole autonomy claim
  is hollow for this vertical.
- **The form is creative.** `questions`, `is_optimized_for_quality`, `inline_context` and `thank_you_page`
  are all testable variables with large quality effects — they belong in the creative genome alongside
  hook and format, and they can be varied far more cheaply than video.
- **Archive-only forms** means form churn accumulates permanently on the Page. Name deterministically
  and reuse rather than regenerate per campaign.
- **Lead PII changes your compliance posture entirely**: you become a processor of end-user personal data
  (name, phone, email, sometimes national ID numbers). DPA, retention policy, deletion path, encryption,
  and breach notification are now in scope. That is a different SOC-2/GDPR conversation than "we store
  ad metrics."

### Open
- Literal reading of the rate-limit formula gives a **new Page zero lead-read quota** (`200 × 24 × 0`).
  There is presumably a floor; Meta does not state one. Probe before launch. `[UNVERIFIED]`
- How long leads remain retrievable. No retention period is stated on any retrieved page; the 90-day term
  appears only inside the rate-limit formula. Practitioner lore says 90 days. `[UNVERIFIED]`
- Meta's Lead Ads Terms of Service (`facebook.com/legal/terms/lead_ads_terms`) returned a JS shell and
  `mbasic` 404s; `facebook.com/ads/leadgen/tos` returned HTTP 500. The Page-level ToS-acceptance gate for
  lead ads could not be confirmed this session. `[UNVERIFIED — treat as a blocking onboarding gate]`

---

## 3. GAP — Money on the ad account: silent no-delivery, and no payments API

### Why it matters
This is the failure mode that will burn the first month. Meta lets you build a complete, valid campaign on
an unfunded ad account and **returns success for every call while delivering nothing**. An autonomous
optimiser reading zero impressions across a fresh cohort will conclude the creative failed and will
regenerate — spending real money on video generation to fix a billing problem.

### What I found (all `[OFFICIAL]`, <https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account>)

**`funding_source`**, verbatim: *"ID of the payment method. If the account does not have a payment method
it will still be possible to create ads but these ads will get no delivery."*

**`account_status`** enum: `1` ACTIVE · `2` DISABLED · `3` UNSETTLED · `7` PENDING_RISK_REVIEW ·
`8` PENDING_SETTLEMENT · `9` IN_GRACE_PERIOD · `100` PENDING_CLOSURE · `101` CLOSED ·
`201` ANY_ACTIVE · `202` ANY_CLOSED.

**`disable_reason`** enum: `0` NONE · `1` ADS_INTEGRITY_POLICY · `2` ADS_IP_REVIEW · **`3` RISK_PAYMENT** ·
`4` GRAY_ACCOUNT_SHUT_DOWN · `5` ADS_AFC_REVIEW · `6` BUSINESS_INTEGRITY_RAR · `7` PERMANENT_CLOSE ·
`8` UNUSED_RESELLER_ACCOUNT · `9` UNUSED_ACCOUNT · `10` UMBRELLA_AD_ACCOUNT ·
`11` BUSINESS_MANAGER_INTEGRITY_POLICY · `12` MISREPRESENTED_AD_ACCOUNT · `13` AOAB_DESHARE_LEGAL_ENTITY ·
`14` CTX_THREAD_REVIEW · **`15` COMPROMISED_AD_ACCOUNT**.

**`spend_cap` is a genuine, API-writable financial kill switch**, verbatim: *"The total amount that this
account can spend, after which all campaigns will be paused, based on `amount_spent`. A value of 0
signifies no spending-cap and setting a new spend cap only applies to spend AFTER the time at which you
set it."* It is controlled with **`spend_cap_action`**: `"reset"` zeroes the `amount_spent` counter,
`"delete"` removes the cap.

**Other financial fields:** `is_prepay_account` (prepay vs postpay), `balance` (*"Bill amount due"*),
`amount_spent`, `min_daily_budget`, `funding_source_details` (funding type codes from `CREDIT_CARD` to
`STORED_BALANCE`).

**There is no documented public API to add a payment method.** `POST /{business_id}/adaccount` accepts an
optional `funding_id` referring to a payment method that must already exist; nothing in the retrieved
reference creates one. `[INFERRED from absence — high confidence]`

**Meta's own financial liability to you is capped at $100.** Commercial Terms: *"aggregate liability
arising out of or relating to any access or use of the Meta Products … will not exceed the greater of one
hundred dollars ($100)"*, and the advertiser *"agree[s] to indemnify and hold us harmless."* `[OFFICIAL]`
<https://www.facebook.com/legal/commercial_terms>

### Design consequence
- **Account-health preflight before every publish and before every optimiser decision.** Read
  `account_status`, `disable_reason`, `funding_source`, `balance`, `spend_cap` vs `amount_spent`. If
  `funding_source` is null or `account_status ∈ {2,3,7,8,9}`, **halt the loop, alert a human, and do not
  interpret zero delivery as a creative signal.** This is the highest-value ten lines of code in the
  system.
- **Zero-impression cohorts are a distinct state, not a bad-performance state.** The completeness-weighted
  posterior in `autonomous-optimization-science.md` must have an explicit "not delivered / not eligible"
  branch that never updates the creative prior.
- **Use `spend_cap` as the per-tenant hard ceiling.** But note the semantics: it applies only to spend
  *after* it is set, and `amount_spent` is cumulative until you `spend_cap_action=reset`. A monthly budget
  policy therefore needs a scheduled reset, and a forgotten reset silently stops all delivery on the 2nd
  of the month.
- **Payment method addition is a permanent human step in onboarding and in recovery.** When a card fails
  mid-flight, the system can detect it in seconds and can do nothing about it. Build the alert path, the
  degraded state, and the "pause everything cleanly rather than accumulate an unpayable balance" behaviour.
- **Contractually allocate overspend risk now.** Meta will pay $100. If your loop overspends a client's
  budget by $9,000 — entirely possible given the 175%-of-highest-daily-budget ceiling documented in
  `meta-optimization-controls.md` — you or the client absorb it. Decide which, in writing, before the
  first customer.

---

## 4. GAP — Onboarding: the list of things no API can do

### Why it matters
The product promise is "the human gives a few inputs." The research nowhere enumerates the gates that
sit between "customer says yes" and "the loop can run." Six months in, this list *is* the onboarding
funnel, and it is where customers churn.

### What I found — the manual gate list

| Gate | API? | Evidence |
|---|---|---|
| Add a payment method to the ad account | **No** | no endpoint in the AdAccount reference; `funding_id` must pre-exist `[INFERRED]` |
| Accept **Custom Audience Terms of Service** | **No** — UI only, **per business** | error `code 200, subcode 1870090 "Custom Audience Terms Not Accepted"` `[OFFICIAL]` |
| Accept Lead Ads Terms of Service | Presumed no | source unreachable `[UNVERIFIED]` |
| Verify a domain (DNS TXT / HTML file) | **No** | domain-verification doc, no endpoint `[OFFICIAL/INFERRED]` |
| Business Verification (for Advanced Access) | **No** — human review, undocumented SLA | `meta-api-foundations.md` |
| Political/SIEP advertiser authorization | **No** — ID upload + mailed code, multi-day | `meta-policy-compliance.md` |
| Create a Facebook Page (mandatory for any ad) | Restricted | ads require a Page identity `[OFFICIAL, object_story_spec]` |
| Connect an Instagram account | Partial — PBIA can be created via API | `meta-video-creative.md` |
| Enforce 2FA on the Business portfolio | No | `meta-api-foundations.md` |
| **Create an ad account** | **Yes** | `POST /{business_id}/adaccount` `[OFFICIAL]` |

**Ad account creation is genuinely automatable.** `POST /{business_id}/adaccount` takes `name`,
`currency` (ISO 4217), `timezone_id`, `end_advertiser`, `media_agency`, `partner` (each a Page/App ID or
the literals `NONE` / `UNFOUND`), and optional `invoice` and `funding_id`. There is an undocumented cap —
error `3979: "You have exceeded the number of allowed ad accounts for your Business Manager at this
time."` `[OFFICIAL]`
<https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/business/adaccount>

**Agency-style access is a documented flow.** `POST /{business_id}/owned_ad_accounts` with
`adaccount_id=act_###` returns `access_status` of `CONFIRMED` or `PENDING` (admin approval);
`POST /{ad_account_id}/assigned_users` with `user={business_scoped_user_id}` and `tasks`; task levels
`['ANALYZE']`, `['ADVERTISE','ANALYZE']`, `['MANAGE','ADVERTISE','ANALYZE']`; `access_type` is `OWNER`
or `AGENCY`. `[OFFICIAL]`
<https://developers.facebook.com/docs/marketing-api/business-asset-management/guides/ad-accounts>

**Two hard people-limits that break naive multi-tenancy:** *"Maximum number of ad accounts per person:
25"* and *"Maximum number of people with access, per ad account: 25."* `[OFFICIAL]`

### Design consequence
- **Model onboarding as an explicit state machine with blocking and non-blocking gates**, exposed to the
  customer as a checklist with per-gate status read back from the API (`account_status`, custom-audience
  ToS probe, `conversion_domain` verification state). This is a product surface, not a support process.
- **Ship degraded modes.** With only a Page + a funded ad account you can run lead-gen and
  click-to-message today. Custom audiences, retargeting, conversion optimisation and AEM each unlock
  behind their own gate. Do not block first spend on the last gate.
- **Never assign a human user per tenant** — the 25-accounts-per-person ceiling caps you at 25 clients on
  that path. Use System Users / BISU tokens as `meta-api-foundations.md` recommends, and make the ceiling
  an explicit architectural note.
- **Pre-flight the custom-audience ToS with a cheap probe** (attempt a trivial audience read/create in a
  sandbox-safe way) rather than discovering `1870090` in the middle of a launch.

---

## 5. GAP — Cold start: bootstrapping knowledge of a brand you have never seen

### Why it matters
`autonomous-optimization-science.md` mentions cold start three times and treats it as a bandit prior
problem. The larger problem is upstream: on day zero the system knows nothing about the brand, the offer,
the customer, the objections, or what the category's ads look like — and it has **zero performance
history on the ad account** to learn from.

### What I found

**The Meta Ad Library API is a real, free competitor-creative corpus — and in the EU it is not limited to
political ads.** From the `ads_archive` reference: *"Ads that did not reach any location in the EU will
only return if they are about social issues, elections or politics."* `[OFFICIAL]`
<https://developers.facebook.com/docs/graph-api/reference/ads_archive/>
Read the other way round: **ads that did reach the EU are returned regardless of type.** `ad_type` filters
are `ALL`, `EMPLOYMENT_ADS`, `FINANCIAL_PRODUCTS_AND_SERVICES_ADS` (*"now replaces CREDIT_ADS"*),
`HOUSING_ADS`, `POLITICAL_AND_ISSUE_ADS`. Rate-limit failures surface as error `613`.

**Full `ArchivedAd` field set** `[OFFICIAL]` <https://developers.facebook.com/docs/graph-api/reference/archived-ad/>:
`id`, `page_id`, `page_name`, `ad_creation_time`, `ad_delivery_start_time`, `ad_delivery_stop_time`,
`ad_creative_bodies[]`, `ad_creative_link_captions[]`, `ad_creative_link_descriptions[]`,
`ad_creative_link_titles[]`, **`ad_snapshot_url`** (*"URL displaying the archived ad with uncompressed
media"*), `languages[]`, `publisher_platforms[]`, `estimated_audience_size`, `currency`, `bylines`,
`delivery_by_region`, `demographic_distribution`.
**Political/issue ads only:** `impressions`, `spend` (both ranged `InsightsRangeValue`).
**EU/UK only:** `eu_total_reach`, `br_total_reach`, `total_reach_by_location`,
`age_country_gender_reach_breakdown`, `target_ages`, `target_gender`, `target_locations`,
`beneficiary_payers`.

The decisive absence: **for ordinary commercial ads there is no spend or impression data.** The only
performance proxy available is **longevity** — `ad_delivery_start_time` to `ad_delivery_stop_time`. A
competitor's ad still running after 90 days is the closest thing to a free win signal.

**Access to the Ad Library API itself could not be verified** — `www.facebook.com/ads/library/api` returns
HTTP 403 to automated fetch. Historically it requires a confirmed identity and a location-verified Meta
developer account. `[UNVERIFIED — check before treating it as a free primitive]`
Meta also exposes `ads_library_search` as a first-party tool on its own MCP server
(`meta-native-automation.md`), which may be the cheaper route to the same data.

### Design consequence
- **Onboarding should run a four-source brand ingest before generating anything:** (1) the client's
  website (offers, proof, objections, tone, product imagery); (2) the client's **own ad account history** —
  past `/adcreatives`, past insights, which is the single highest-value cold-start asset and is settled,
  immutable data outside the 28-day window; (3) the Page's organic posts (what already resonates,
  free engagement priors); (4) the **Ad Library** for the category, scored by ad longevity.
- **Use longevity, not impressions, as the Ad Library performance proxy**, and say so explicitly so
  nobody builds a spend model on data that only exists for political ads.
- **Separate two cold starts that the dossiers conflate.** *Brand* cold start is solvable by ingestion.
  *Account* cold start is a pixel-history problem: a brand-new dataset has no conversion history, so
  `OUTCOME_SALES` + `PURCHASE` will sit in Learning Limited indefinitely at SMB budgets. The correct
  opening move is a cheaper optimisation event (landing-page views, or an upper-funnel custom event) and a
  planned step-down to `PURCHASE` once the weekly event count supports it — tied to the per-ad-set
  `dynamic_lp_conversions_threshold` that `meta-insights-measurement.md` documents.
- **The 20% forced-randomisation slice from `autonomous-optimization-science.md` is unaffordable at cold
  start** on a $50/day SMB account. The exploration schedule must be a function of budget, not a constant.

---

## 6. GAP — Catalogue / commerce advertisers

### Why it matters
For any ecommerce advertiser above trivial scale, the highest-ROAS Meta surface is **Advantage+ catalogue
ads**, whose creative is assembled by Meta from a product feed — no generated video involved. A platform
that only knows how to make video ads will lose to the client's existing catalogue campaigns on the
bottom of the funnel and will not understand why.

### What I found `[OFFICIAL]`
- `POST /{business_id}/owned_product_catalogs` — parameters `name` (required), `vertical` (commerce,
  hotels, flights, vehicles, destinations…; defaults to commerce), `da_display_settings`,
  `catalog_segment_filter`, `business_metadata`, `parent_catalog_id`, plus vertical-specific settings.
  <https://developers.facebook.com/docs/marketing-api/reference/product-catalog/>
- ProductCatalog node: `product_count`, `feed_count`, `default_image_url`, `fallback_image_url`,
  `is_catalog_segment`, `is_local_catalog`. Edges: `products`, `data_sources` (feeds/session containers),
  `product_sets`, `external_event_sources` (the pixels/apps that power dynamic ads), `assigned_users`.
- The reference explicitly notes a **Terms-of-Service acceptance through Business Manager** requirement
  in addition to a Marketing API access level.
- Advantage+ catalogue ads require three things: *"Create a feed from your catalog"*, a pixel or App
  Events source *"to measure actions, such as purchases, and profile target audiences"*, and the ads
  themselves. <https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads>
- **Catalogue rate limits are the tightest in the API surface:** `catalog_management` =
  `20000 + 20000 × log2(unique users)` per ad account per hour; **`catalog_batch` = `200 + 200 ×
  log2(unique users)` per ad account per hour**. `[OFFICIAL]`
  <https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting>

### Design consequence
- **Catalogue ads are a second, parallel creative pipeline** with a different creative shape
  (`template_data`, product-set-driven) and different levers (feed quality, product set segmentation,
  `da_display_settings`). Budget for it or explicitly declare ecommerce BOF out of scope.
- **`catalog_batch` at ~200 calls/hour for a low-traffic catalogue is a hard throughput ceiling.** Feed
  ingestion for a 50k-SKU store must go through scheduled **feeds**, not the batch API. Getting this wrong
  is a multi-day sync backlog.
- **The correct division of labour for ecommerce is: Meta's catalogue engine owns retargeting and
  bottom-funnel; your generated video owns prospecting and new-angle discovery.** Frame the product that
  way rather than competing with a free, better system on its home turf.

### Open
- `promoted_object` field shapes for catalogue ad sets (`product_catalog_id`, `product_set_id`) are listed
  in `meta-campaign-publishing.md` but the catalogue creative template shape was not retrievable this
  session (`/docs/marketing-api/dynamic-ads/getting-started` 404s). `[UNVERIFIED]`
- Whether video creative is supported in Advantage+ catalogue ads. Not answered by any page retrieved.
  Load-bearing: it decides whether the video pipeline can feed the catalogue surface at all. `[UNVERIFIED]`

---

## 7. GAP — Who is liable for an autonomously published ad

### Why it matters
There is a real, specific, quotable chain of liability, and it ends on the platform. No dossier states it.

### What I found (all `[OFFICIAL]`)

**Self-Serve Ad Terms** — <https://www.facebook.com/legal/self_service_ads_terms> (via `mbasic`)
- *"You are solely responsible for the Order, ad content, targeting decisions, and ad placements."*
- *"We do not guarantee the reach or performance that your ads will receive."*
- On acting for someone else: *"You represent and warrant that you have the authority to and will bind the
  advertiser to these Self-Serve Ad Terms."*
- **And the sting:** *"If the advertiser you represent violates these Self-Serve Ad Terms … we may hold
  you responsible for that violation."*

**Commercial Terms** — Meta's aggregate liability *"will not exceed the greater of one hundred dollars
($100)"*; the business indemnifies Meta.

**Platform Terms** — <https://developers.facebook.com/terms/>
- §2.c.ii: you must obtain *"all rights necessary from all applicable rights holders"* for content.
- §3.a.iv: prohibits *"Selling, licensing, or purchasing Platform Data."*
- §5.b (Tech Providers): you must *"contractually prohibit [your Client] from Processing Platform Data in
  a way that would violate these Terms"* and *"you are responsible for their acts and omissions."*
- §7.c: Meta may audit *"no more than once a calendar year unless there is a Necessary Condition,"* with
  **10 business days' written notice**, requiring *"all necessary physical and remote access"*, and you
  reimburse Meta's costs if non-compliance is found.

**Ad Creative Generative AI Terms** — <https://www.facebook.com/legal/terms/ad_creative_generative_ai_terms>
(via `mbasic`) — this resolves an open question raised in `meta-native-automation.md`:
- *"Meta retains all rights that it otherwise possesses in Output generated by the Ad Creative AIs."*
- *"Use or publication of Output outside of Meta's platforms is unauthorized and a violation of these
  Terms."*
- *"You may not (i) use the Ad Creative AIs or any Output to develop models, algorithms, or systems to
  compete with Meta, (ii) decompile or reverse engineer…"*
- *"You acknowledge and agree that all or a portion of the Output is digitally created, enhanced or
  altered by GenAI, and you must not misrepresent Output as human-generated when it is not."*
- **No indemnity from Meta.**

### Design consequence
- **You are a Tech Provider and you inherit your clients' violations.** Two direct build requirements:
  a written client agreement carrying the Platform-Terms-mandated flow-downs, and an **audit-ready
  evidence trail** — every ad the system published, the inputs that produced it, the policy checks it
  passed, and the human who approved the offer — retained and retrievable on 10 business days' notice.
  Log design is a legal requirement, not an ops nicety.
- **The Advantage+ generative enhancements are a one-way door.** If you let Meta's `creative_features_spec`
  generate or transform an asset, that Output is Meta's, is disclosure-bound, and **may not be published
  off-Meta**. That destroys the "generate once, run on Meta + TikTok + YouTube" story for any asset Meta
  touched. Keep a hard boundary: assets you generate are yours and portable; assets Meta enhances are
  Meta-platform-only and must be tagged as such in the asset store.
- **"Must not misrepresent Output as human-generated"** is a real, quotable obligation that applies to
  Meta-generated Output specifically. It is *narrower* than the blanket AI-disclosure regime the SEO blogs
  claim (correctly debunked in `meta-policy-compliance.md`), but it is not nothing — and it points the same
  way as the EU AI Act Art. 50 question already open in `creative-production-pipeline.md`.
- **Meta's $100 cap means every dollar of platform-caused waste is allocated between you and the client by
  your contract alone.** Write a spend-guarantee / credit policy before the first customer, not after the
  first incident.

---

## 8. GAP — Failure modes with money attached, and what the human must actually approve

No dossier contains a consolidated failure catalogue. Here is one, ordered by expected cost.

**8.1 Silent no-delivery.** Unfunded / `UNSETTLED` / `IN_GRACE_PERIOD` account. Everything returns 200,
insights are all zeros, the optimiser regenerates creative to fix a billing problem. **Mitigation:** §3
preflight; a "not eligible to deliver" state that never updates a creative prior.

**8.2 Runaway budget.** From `meta-optimization-controls.md`: daily budgets can overspend **75%** in a
day, weekly cap is 7×, and the 175% ceiling **anchors to the highest budget set that day** — so writing a
large budget and immediately writing it back does *not* undo the exposure. **Mitigation:** every budget
write passes a validator that computes worst-case daily and weekly exposure before the write; per-tenant
`spend_cap` as the backstop; a native Automated Rule as a dead-man's switch, since it evaluates
server-side even if your loop is down.

**8.3 Non-idempotent publish.** The Marketing API has no idempotency key. A timeout on `POST /act_/ads`
may or may not have created the ad; a naive retry duplicates it, doubling spend on one creative and
corrupting the bandit's arm accounting. **Mitigation:** embed a client-generated UUID in the object `name`
and reconcile by read-back before retrying. Never retry a write blindly. `[INFERRED — no idempotency
mechanism appears anywhere in the retrieved API documentation]`

**8.4 Currency exponent.** Meta budgets are expressed in the ad account's **minor units** — `daily_budget:
5000` is $50.00 in USD but ¥5,000 in JPY (zero-decimal). A platform that stores budgets as floats and
multiplies by 100 unconditionally overspends 100× in zero-decimal currencies. **Mitigation:** read
`currency` on the ad account at onboarding, resolve its exponent from Meta's currency offsets, and make
budget a typed money object end-to-end. This is a classic six-months-in discovery. `[INFERRED —
high confidence; verify the offsets endpoint on a live account]`

**8.5 Wrong destination or wrong event.** A `conversion_domain` / link mismatch buys clicks to a 404 and
risks a policy strike; a wrong `promoted_object.custom_event_type` optimises toward an event that never
fires, so the ad set never leaves learning and spends its whole budget exploring.

**8.6 Object-ceiling exhaustion.** See §9.1 — a per-creative ad-set spawner will hit 6,000 ad sets.

**8.7 Portfolio-transitive restriction.** `disable_reason = 11 BUSINESS_MANAGER_INTEGRITY_POLICY` implies
the whole portfolio. One Business Manager per client is not optional.

**8.8 Lead data breach.** Once you hold `leads_retrieval` data you hold names, phone numbers and in some
markets national ID numbers for people who never heard of you.

### What the human must actually approve
The research implicitly assumes the approval unit is "the ad." It should not be — approving 40 ads a week
is not autonomy. The defensible split:

| Human approves (once, or on change) | System decides (continuously) |
|---|---|
| The **offer** and any claim that could be substantiated or not | Which hook/format expresses the offer |
| The **destination** and its content | Which creative variants exist |
| The **budget ceiling** and pacing envelope | Budget allocation inside the envelope |
| **Brand constraints** — what must never appear, which Advantage+ enhancements are opted out | Placement, targeting, bidding |
| **Spokesperson likeness / voice** rights | Copy variants within approved claims |
| Escalations: any policy rejection, any `dri_copyright`/`dri_counterfeit` hit, any budget step above N× | Pauses, scaling within envelope, creative retirement |

**Design consequence:** an approval object with a scope and a TTL, not an approval queue of ads. Rejections
in the `dri_*` buckets (`meta-policy-compliance.md`) must halt the entire creative lineage globally and
page a human — those are rights-holder complaints, not classifier noise.

---

## 9. Corrections and smaller gaps

### 9.1 CORRECTION — the ad account object ceiling is 6,000, not 5,000
`meta-api-foundations.md` lists as an open question: *"The 5,000 campaigns / 5,000 ad sets / 5,000 ads
figure (error #1487809) is verified-secondary only."* The official AdAccount reference publishes the
table `[OFFICIAL]`:

| Limit | Value |
|---|---|
| Ad accounts per person | 25 |
| People with access, per ad account | 25 |
| Ads per **regular** ad account | 6,000 non-archived non-deleted |
| Ads per **bulk** ad account | 50,000 non-archived non-deleted |
| Archived ads per ad account | 100,000 |
| Ad sets per regular / bulk account | 6,000 / 10,000 |
| Archived ad sets | 100,000 |
| Campaigns per regular / bulk account | 6,000 / 10,000 |
| Archived campaigns | 100,000 |
| Images per ad account | Unlimited |

<https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account>

**Design consequence:** archived objects sit in a *separate* 100,000 bucket, so **archiving is the
correct garbage-collection primitive** — it frees live headroom without destroying history. A system
generating 40 ads/week hits 6,000 in ~3 years on one account, but a per-creative ad-set spawner
(`autonomous-optimization-science.md`) burns ad sets far faster, and the bulk tier only raises ad sets to
10,000, not 50,000. Continuous archival must be in the loop from day one.

Also still open, and now sharper: the reference confirms *"Ad creation is limited for a given ad account
based on the daily spend limit"* with error `613 / subcode 1487225 "User request limit reached"` and the
remedy *"increase the daily spend limit"* — but **publishes no spend→ad-count tier table**. `[OFFICIAL,
partially]` This is a real cold-start constraint: a low-spend new account can be rate-limited out of
creative volume regardless of your architecture.

### 9.2 Ad limits per Page / Ad Volume API — still unresolved
The `ads_volume` edge exists on the AdAccount node (*"query the volume of ads currently running or in
review"*), but every dedicated page I tried (`/docs/marketing-api/ad-volume/`, `/ad-limits`,
`/reference/ad-account/ads_volume/`) either 404s or truncates. The spend-tier table behind
`limit_on_ads_running_or_in_review` remains unpublished. `[UNVERIFIED]` — this is the same gap
`meta-policy-compliance.md` flagged; it is now confirmed as genuinely unfetchable, not merely missed.

### 9.3 Click-to-message / CTWA is essentially absent from the research
`CTWA` appears twice across 16,600 lines. For local SMB service businesses in most of the world outside
the US, click-to-WhatsApp is *the* dominant ad format. It needs: a WhatsApp Business Account, a registered
phone number, `promoted_object.whats_app_business_phone_number_id` (the field is already listed in
`meta-campaign-publishing.md`), and its own conversion measurement. Every documentation path I tried
404'd this session. **This deserves its own dossier if SMB is a target market.** `[UNVERIFIED]`

### 9.4 Proving the platform works
Nothing addresses how you demonstrate *your* incremental value to a client, as distinct from Meta's.
`autonomous-optimization-science.md` correctly notes that fleet-scale account-level randomisation is an
unresolved governance question — but the commercial reality is that you will be asked "is this better
than what we did before?" in month two. Design the account-level before/after and the geo-holdout now,
while there is still a clean pre-period.

### 9.5 Your own billing model
Not covered anywhere. Percentage-of-ad-spend aligns you with spending more, not with performance, and in
several jurisdictions pulls you toward agency/broker regulation. Flat SaaS + performance component is the
safer shape. It also interacts with §3: if you bill a percentage and the client's card fails, you have two
billing failures, not one.

### 9.6 Creative rights beyond Meta
`creative-production-pipeline.md` flags US synthetic-voice statutes as unresearched. Add: model releases
for AI-generated humans who resemble real people, music licensing for generated tracks used in paid media,
and the fact that **Veo's Google indemnity explicitly excludes trademark claims arising from use "in trade
or commerce"** (`video-gen-google-veo.md`) — which is exactly paid advertising. The indemnity most likely
does not cover the only use you have for it.

---

## 10. Recommended additions to the research programme

Ranked by expected cost of not knowing:

1. **`destination-and-offer-generation.md`** — automated landing pages, the match rule, domain
   verification per tenant, AEM in 2026, on-Meta destinations as the SMB default. (Biggest hole.)
2. **`lead-gen-vertical.md`** — forms, webhooks, CRM delivery, lead-quality feedback into the optimiser,
   PII compliance. Needed before the SMB market is addressable at all.
3. **`onboarding-and-account-lifecycle.md`** — the gate state machine, degraded modes, account health,
   payment failure, spend_cap policy, tenancy limits.
4. **`commercial-and-legal.md`** — Tech Provider obligations, client contract flow-downs, audit
   readiness, GenAI Terms boundary, overspend allocation, insurance.
5. **`catalogue-commerce.md`** — if ecommerce is in scope.
6. **`click-to-message.md`** — if non-US SMB is in scope.

Each of the first four is, on the evidence above, worth more to the build than another 1,000 lines on
Marketing API field shapes.
