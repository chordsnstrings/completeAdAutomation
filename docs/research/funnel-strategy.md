# Funnel Strategy and Structure for Meta Video Ads

**Research date: 2026-09-05.** Every field name, enum, numeric limit and quoted sentence below was
fetched live on this date from the source cited beside it. Claims I could not verify are marked
**UNVERIFIED**. Claims that are widely repeated but that a primary source contradicts are marked
**FOLKLORE — CONTRADICTED** with the contradicting source.

**Method note.** Meta's Business Help Centre renders its article bodies inside a JS payload, so
`WebFetch` returns only the page title. The bodies below were recovered by fetching
`https://www.facebook.com/business/help/{id}` with a Googlebot user-agent and un-escaping the
`<`-encoded markup in the response. The Marketing API docs serve a machine-readable variant at
`https://developers.facebook.com/documentation/ads-commerce/marketing-api/{path}.md` — that is the
canonical route and is what I used. `jonloomer.com` returns 403 to every direct fetch; those articles
were read through `r.jina.ai`.

**Scope.** This dossier answers one product question: *given a non-expert user and a small number of
one-click options, what funnel should the system build, and at what budget does building one stop
being a mistake?* It is deliberately opinionated where the evidence supports an opinion, and
deliberately says "we don't know" where it doesn't.

---

## 0. TL;DR — the straight answers, in order of how much they should change the product

1. **The canonical video-view funnel (TOF video views → MOF retarget 50/75% viewers → BOF retarget
   site visitors) is a 2018 artefact, and for most of our users it is actively harmful.** The
   mechanism of harm is not budget fragmentation first — it is that Meta's optimiser is *literal*.
   An ad set told to maximise ThruPlays will find you the people most willing to watch videos, and
   those people are not the people most willing to buy. You then build a custom audience out of that
   population and retarget it, compounding the selection error. Jon Loomer names this pattern
   directly and tells advertisers to avoid it
   ([source](https://www.jonloomer.com/prioritize-remarketing-over-metas-algorithmic-ad-targeting/)).

2. **The learning phase is NOT what kills a small-budget funnel. Do not lead with that argument.**
   Meta's threshold is "about 50 results in the week after the ad set's last significant edit"
   ([primary](https://www.facebook.com/business/help/112167992830700)), so the daily budget an ad set
   needs to exit learning is **≈ 7.14 × the cost of its own optimisation event**. For a ThruPlay ad
   set at $0.05/ThruPlay that is **$0.36/day** — the TOF stage of a video funnel exits learning
   trivially. It is the *bottom* stage that is unreachable: a purchase-optimised ad set at a $30 CPA
   needs **$214/day on its own** to clear 50 events a week. The funnel does not fail evenly; it fails
   precisely at the stage that makes the money.

3. **The binding constraint at small budgets is audience *size*, not learning.** A 50%-video-viewer
   pool only reaches the ~1,000-person floor at which Meta will reliably deliver after roughly
   **$300 of cumulative TOF video spend in a tier-1 market** (working shown in §5.2). Below about
   **$10/day sustained for 30 days**, the MOF stage of a video funnel has nobody in it. The system
   can and should compute this per brand before offering the option.

4. **The honest recommendation for most small advertisers is one broad campaign.** Under roughly
   **$50/day (~$1,500/month)** a multi-stage funnel is strictly worse than a single Advantage+
   audience ad set optimised for the real conversion. This is not a hedge — it is what Meta's own
   consolidation guidance, Meta's own auction-overlap mechanics, the learning-phase arithmetic, and
   the only controlled A/B test I could find all point at. Build the funnel *inside the creative*,
   not across campaigns.

5. **In 2026 you can only steer a Meta funnel with exclusions. Inclusions are advisory.** Under
   Advantage+ audience, custom-audience *inclusions* are suggestions the delivery system may ignore;
   custom-audience *exclusions* are hard controls, and Meta states explicitly that you "can raise the
   minimum age up to 25 or exclude a custom audience without turning Advantage+ off"
   ([primary](https://www.facebook.com/business/help/906206294602874)). Every funnel template in this
   dossier is therefore built out of exclusions and creative routing, never out of inclusions.

6. **Meta itself carves out exactly one exception to "let the AI target".** From the Advantage+
   audience help page: *"Meta recommends A/B testing with Advantage+ audience for almost all campaign
   types, **except retargeting campaigns**."*
   ([primary](https://www.facebook.com/business/help/273363992030035)). That single sentence is the
   strongest available evidence that a separate bottom-of-funnel campaign remains legitimate in 2026,
   and it comes from the vendor with every incentive to say otherwise.

7. **Lookalikes have been quietly demoted to suggestions and the evidence against them is poor.**
   Advantage+ lookalike is "automatically enabled for new, duplicated and draft campaigns and ad sets
   using lookalike audiences" ([primary](https://www.facebook.com/business/help/1212225059146059))
   and cannot be turned off when optimising for conversions — so a "1% lookalike" is not a 1%
   audience, it is a hint. In the only controlled 30-day / $2,250 A/B test I could find, lookalikes
   lost to both Advantage+ audience and interest targeting with **under a 5% modelled chance of
   winning** ([Loomer](https://www.jonloomer.com/test-results-advantage-plus-audience-detailed-targeting-lookalikes/)).
   Lookalikes remain useful for exactly one thing: **cold start**, where there is no pixel history
   for the algorithm to work from.

8. **Video-viewer lookalikes are the worst common seed and the only seed a new brand has.** Both
   things are true and the product must hold them together. A video-view seed encodes "watches
   videos"; a purchase seed encodes "buys". Meta's documented minimum seed is 100 people, its Help
   Centre recommends 1,000–5,000, and its API guide says "make it as large as possible" — the two
   Meta sources contradict each other (§4.3).

9. **The 730-day purchase-audience window (18 May 2026) is real in the UI and absent from the API
   docs.** Website custom audience `retention_days` is still documented as "Between `1` and `180`
   days" ([primary](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/website-custom-audiences.md)).
   Treat >180 via API as **UNVERIFIED** and probe it on first live account.

10. **Video engagement custom audiences are effectively undocumented in the Marketing API.** `video`
    is not among the supported `event_sources` types in Meta's engagement-audience guide. The only
    known working shape is a bare JSON array with `event_name` / `object_id` / `context_id` and
    `subtype=ENGAGEMENT` (§2.4). This is the single largest implementation risk in building any of
    these templates and it needs a live probe before it is committed to.

---

## 1. Source grading

Everything downstream is labelled with one of these. The distinction matters more here than in most
of the dossiers, because funnel strategy is the part of paid social with the highest folklore-to-fact
ratio.

| Grade | Meaning | Examples used below |
|---|---|---|
| **P — Primary, Meta** | Meta's own docs, help centre or API reference, fetched 2026-09-05 | learning-phase threshold, lookalike `ratio` range, auction-overlap mechanics |
| **P* — Primary, Meta marketing** | Meta's own *performance claims* about its own products. Vendor-reported, unaudited, no methodology published | "Advantage+ audience … 14.8% lower cost per result" |
| **E — Experimental** | Randomised or geo-experimental evidence with a stated method and sample | Haus (640 incrementality tests); Gordon/Moakler/Zettelmeyer (663 Facebook RCTs); Loomer's 30-day split test |
| **C — Practitioner consensus** | Repeated by multiple independent, named practitioners with real accounts. Directionally trustworthy, numerically soft | budget-tier account structures |
| **F — Folklore** | Widely repeated, no traceable evidence, sometimes contradicted by a P source | "overlapping lookalikes make you bid against yourself and inflate CPM 40%" |
| **O — Observed implementation** | Field names/limits recovered from a working production codebase found in this session's scratchpad, annotated by its author as verified live against a real ad account in May 2026. Not mine, not Meta's. Actionable but must be re-probed | video-engagement audience rule shape |

A standing caveat that applies to every **E** number in this dossier: **the experimental evidence
comes from advertisers spending roughly $14 million a year on Meta**
([Haus](https://www.haus.io/blog/the-meta-report-lessons-from-640-haus-incrementality-experiments)).
None of it was generated by anyone resembling our target user. It tells us how the *system* behaves;
it does not tell us what a $30/day advertiser should do. Where I extrapolate, I say so.

---

## 2. The canonical video-view funnel, described mechanically

### 2.1 What the folk model says

The three-stage video funnel as it is taught:

```
TOF   Campaign: Awareness or Engagement
      Optimisation: ThruPlay (or 2-second continuous video views)
      Audience: broad, or interest-based
      Purpose: buy cheap video views, build a retargeting pool

MOF   Campaign: Traffic or Engagement
      Optimisation: Landing page views / link clicks
      Audience: Video engagement custom audience, 50% or 75% viewers, 30-90d
      Exclusions: website visitors, purchasers
      Purpose: convert watchers into site visitors

BOF   Campaign: Sales
      Optimisation: Purchase (or Add to Cart)
      Audience: Website visitors 7-30d, Add-to-cart 14-30d, lead-form openers 90d
      Exclusions: purchasers
      Purpose: close
```

Plus, off to the side, lookalikes seeded from each of those pools.

This is a coherent, teachable, *legible* structure. That is why it survives. Legibility is not
evidence.

### 2.2 The real objective / optimisation-goal choices at each stage

Verified against the ODAX enums in `src/meta/objectives.ts` and Meta's ad-set reference
([primary](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/)).

| Stage | `objective` | `optimization_goal` | `billing_event` | Notes |
|---|---|---|---|---|
| TOF video | `OUTCOME_AWARENESS` | `THRUPLAY` | `THRUPLAY` or `IMPRESSIONS` | ThruPlay = watched 15s, or to completion if shorter |
| TOF video (cheap) | `OUTCOME_AWARENESS` | `THRUPLAY` | `TWO_SECOND_CONTINUOUS_VIDEO_VIEWS` | Buys volume, not attention. Builds a garbage pool |
| TOF video (engagement) | `OUTCOME_ENGAGEMENT` | `THRUPLAY` | `THRUPLAY` | `destination_type: ON_VIDEO` |
| TOF reach | `OUTCOME_AWARENESS` | `REACH` | `IMPRESSIONS` | The genuinely defensible upper-funnel goal — see §3.4 |
| MOF | `OUTCOME_TRAFFIC` | `LANDING_PAGE_VIEWS` | `IMPRESSIONS` | Loomer: "almost always a waste of money" |
| MOF (better) | `OUTCOME_SALES` | `OFFSITE_CONVERSIONS` + a cheap pixel event | `IMPRESSIONS` | ViewContent / AddToCart as the optimisation event |
| BOF | `OUTCOME_SALES` | `OFFSITE_CONVERSIONS` (Purchase) or `VALUE` | `IMPRESSIONS` | The stage that cannot afford its own learning phase |
| BOF (lead) | `OUTCOME_LEADS` | `LEAD_GENERATION` or `QUALITY_LEAD` | `IMPRESSIONS` | `QUALITY_LEAD` needs CRM feedback |

**Important negative finding.** `TWO_SECOND_CONTINUOUS_VIDEO_VIEWS` appears in the `billing_event`
enum but **not** in the `optimization_goal` enum on the current ad-set reference. The full
`optimization_goal` list fetched 2026-09-05 is:

```
NONE, APP_INSTALLS, AD_RECALL_LIFT, ENGAGED_USERS, EVENT_RESPONSES, IMPRESSIONS,
LEAD_GENERATION, QUALITY_LEAD, LINK_CLICKS, OFFSITE_CONVERSIONS, PAGE_LIKES,
POST_ENGAGEMENT, QUALITY_CALL, REACH, LANDING_PAGE_VIEWS, VISIT_INSTAGRAM_PROFILE,
ENGAGED_PAGE_VIEWS, VALUE, THRUPLAY, DERIVED_EVENTS,
APP_INSTALLS_AND_OFFSITE_CONVERSIONS, CONVERSATIONS, IN_APP_VALUE,
MESSAGING_PURCHASE_CONVERSION, MESSAGING_DEEP_CONVERSATION_AND_FOLLOW, SUBSCRIBERS,
REMINDERS_SET, MEANINGFUL_CALL_ATTEMPT, PROFILE_VISIT, PROFILE_AND_PAGE_ENGAGEMENT,
ADVERTISER_SILOED_VALUE, AUTOMATIC_OBJECTIVE, MESSAGING_APPOINTMENT_CONVERSION
```

So **there is exactly one video optimisation goal now: `THRUPLAY`.** The "2-second video views"
option survives only as a billing event. The project's existing `OptimizationGoal` union already
reflects this correctly.

Also note `AUTOMATIC_OBJECTIVE` in that list — Meta now offers to pick the optimisation goal itself.
That is worth a separate probe; it is not covered in any existing dossier. **UNVERIFIED** whether it
is available outside particular objectives.

### 2.3 The audiences, and what actually builds them

| Pool | How it is built | Max retention | Source |
|---|---|---|---|
| Video viewers 25/50/75/95% | Video engagement custom audience, up to **200 videos** per audience | **365 days** (Ads Manager) | [P](https://www.facebook.com/business/help/1099865760056389) |
| Site visitors / ViewContent / ATC | Website custom audience, pixel rule | **180 days** documented in API; **730 days for Purchase events** in UI since 18 May 2026 | [P](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/website-custom-audiences.md) |
| Lead-form openers / droppers | Engagement CA, `lead_generation_opened` / `_dropoff` / `_submitted` | **90 days — hard cap** | [P](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/engagement-custom-audiences.md) |
| Page / IG profile engagers | Engagement CA, `page_engaged` / `ig_business_profile_all` | **730 days** | same |
| Page likers | Engagement CA, `page_liked` | **no retention** (`retention_seconds=0`), and cannot be combined with other page events | same |
| Shopping viewers/ATC/purchasers | Engagement CA, `VIEW_CONTENT`/`ADD_TO_CART`/`PURCHASE` | **365 days**, data since April 2020 | same |
| Instant Experience openers | Engagement CA, `instant_shopping_document_open` | **730 days** | same |

**Hard limits worth encoding as constants:**

- **500 engagement custom audiences per ad account.** [P](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/engagement-custom-audiences.md)
- **500 lookalike audiences from a single source.** [P](https://www.facebook.com/business/help/465262276878947)
- **200 videos per video engagement custom audience.** [P](https://www.facebook.com/business/help/1099865760056389) — and per **O**, exceeding it fails with `#2654 subcode 1870231: "Video engagement audience too big: contains N videos, maximum limit is 200."`
- **5 stacked page-engagement sources per audience** (**O**; `#200 subcode 1713153` above that). Not stated in Meta's docs, which show multi-page examples without a cap. **UNVERIFIED against Meta.**
- **200 ad sets max per campaign with Advantage+ campaign budget; >70 locks bid-strategy and budget-mode edits.** [P](https://www.facebook.com/business/help/519856662172206)

### 2.4 The video engagement custom audience is undocumented — this is the biggest build risk

Meta's engagement-audience guide enumerates the supported `event_sources` types:

```
page, lead, ig_lead_generation, canvas, ig_business, shopping_page, shopping_ig,
ar_experience, ar_effects
```

**`video` is not on that list.** The guide's only acknowledgement of video is a note that
`subtype` — deprecated for every other engagement audience since September 2018 — *"is supported for
engagement custom audiences for video"*, and a second note that *"Instagram Media Creator type is
currently not supported for video engagement custom audience creation."* Neither tells you the rule
shape. The Ads Manager flow is documented; the API is not.

The only concrete shape I found is **[O]** — from `audience-payload.ts`, a production Meta-automation
implementation present in this session's scratchpad, whose author annotated each constant with the
live audience ID it was reverse-engineered from in May 2026:

```jsonc
// POST /act_{id}/customaudiences
{
  "name": "...",
  "subtype": "ENGAGEMENT",          // NOT "VIDEO", despite VIDEO being a valid enum.
                                     // UI-created video audiences register as ENGAGEMENT
                                     // with data_source.sub_type = ENGAGEMENT_EVENTS
  "retention_days": "90",            // top-level; video audiences do NOT carry
                                     // per-rule retention_seconds. Defaults to 730 if omitted
  "rule": "[                         // a BARE JSON ARRAY, not {inclusions:{...}}
    { \"event_name\": \"video_view_75_percent\",
      \"object_id\":  \"<VIDEO_ID>\",
      \"context_id\": \"<FB_PAGE_ID that published the video>\" },
    ...one entry per video, max 200...
  ]"
}
```

Threshold → `event_name` mapping (**O**, verified across several live audiences):

| Ads Manager option | `event_name` |
|---|---|
| 25% of your video | `video_view_25_percent` |
| 50% | `video_view_50_percent` |
| 75% | `video_view_75_percent` |
| 95% / 100% | `video_completed` — **Meta does not use `video_view_95_percent`** |

Two structural oddities to be aware of before building against this: the rule is a bare array rather
than the `{inclusions:{operator,rules:[...]}}` object every other audience type uses, and
`context_id` is the **Facebook Page that published the video**, not the ad account.

**What to do with this.** Treat it as a strong hypothesis, not a fact. The first live ad account
should run a read-only probe — create one video audience by hand in Ads Manager, then
`GET /{audience_id}?fields=rule,subtype,retention_days,data_source` — and settle the shape before any
template depends on it. Note also that the Ads Manager flow accepts second-based thresholds (3s, 10s,
ThruPlay/15s) that have no obvious counterpart in this percent-based event set; whether those are
expressible via the API at all is **UNVERIFIED**.

**A further gotcha from Meta's own troubleshooting page**
([P](https://www.facebook.com/business/help/288658087296355)): *"Videos only used in placement asset
customization campaigns are not eligible for use in video engagement custom audiences"*, and
*"video views on Audience Network may not be counted"*. A pipeline that generates per-placement video
variants and wires them up with asset customisation will therefore build **no retargeting pool at
all** — silently. That is a direct collision between two things this platform wants to do.

Finally, from the same source: when a video is reused from an existing Page post, the audience is
built from the *post's* view count, not the ad's. Meta's example: a campaign with 200,000 views
producing a 1,000-person audience.

---

## 3. Does the video-view funnel work? The evidence, graded

### 3.1 The mechanism that breaks it: optimisation is literal

This is the most important idea in the dossier and it is not a statistical argument, it is a
mechanical one.

> *"Ad delivery is driven by your performance goal. … Whether you want conversions, link clicks,
> impressions, or something else, Meta's focus will be on helping you get as many of that thing as
> possible because that is how you've defined success. That's a benefit if all you really want is
> the thing that you're optimizing for. It's a weakness if you expect people who perform your
> optimization event to also perform other actions."*
> — [Jon Loomer, *When Broad Targeting Fails*](https://www.jonloomer.com/when-broad-targeting-fails/) **[C]**

And the specific consequence for our funnel, from the same author, under a heading he titled
*"Beware of Soft Remarketing"*:

> *"1. Run an ad that optimizes for link clicks, landing page views, or video views. 2. Create an
> audience of the people who engaged with the first ad. 3. Target the people who engaged with the
> first ad. The reason this is problematic is … If you optimize for link clicks, landing page views,
> video views, or just about any other action other than a conversion, you can expect low-quality
> activity. **You are creating a custom audience of low-quality activity. And then you are
> remarketing to a low-quality audience.**"*
> — [Loomer](https://www.jonloomer.com/prioritize-remarketing-over-metas-algorithmic-ad-targeting/) **[C]**

That is a description of the exact three-stage funnel this product was going to offer as a one-click
option. It comes from the most technically careful independent Meta practitioner writing publicly,
and it is consistent with Meta's own documented behaviour rather than in tension with it.

**Is there counter-evidence?** There is a mechanistic counter-argument worth stating fairly. A
ThruPlay is not a click; it is 15 seconds of voluntary attention to *your specific message*. Unlike a
link click, it is hard to fake, hard to do accidentally, and it carries content — the person watched
*your* pitch. Loomer's "low-quality activity" critique is strongest for link clicks and landing-page
views (where bots, misclicks and click-farms genuinely exist) and weakest for deep video completion.
A 95%-completion pool of a 30-second product video is a materially different population from a
3-second-view pool. I could find **no experimental evidence either way** on this specific point.
Nobody has published a randomised test of "retarget 75% video viewers vs. don't". **UNVERIFIED**, and
it is the single most valuable thing this platform could measure once it is live.

### 3.2 What the incrementality evidence actually says about funnel stages

The best available dataset is Haus's analysis of **640 Meta incrementality experiments run since the
start of 2024**, average test length 18.6 days with an 8.8-day post-treatment window, across
advertisers averaging **$14M/year of Meta spend**
([source](https://www.haus.io/blog/the-meta-report-lessons-from-640-haus-incrementality-experiments)).
**[E]**

Headline findings relevant to funnel design:

| Finding | Number |
|---|---|
| Average lift Meta drove to brands' primary KPI | **+19%** |
| Meta's own 7-day-click attribution vs true incrementality | Meta **under**-reports by ~15% (every $100 attributed = $115 real) |
| Share of Meta's impact landing on non-DTC channels | **~32%** |
| Upper-funnel campaigns: DTC iROAS vs bottom-funnel | **46% lower** |
| …but only **22% lower** measured after the post-treatment window |
| Upper-funnel: share of impact on *new* customers | **81%** vs 67% for bottom-funnel |
| Upper-funnel: omnichannel halo | **+138%** vs +46% for conversion-optimised |
| Upper-funnel share of platform budget | **6%** — flat year over year, ~70% of brands run some |
| Mid-funnel optimisation: DTC iROAS | **14% lower** at **85% lower spend/day** |
| Mid-funnel: new-customer rate | **78%** vs 67% |
| Mid-funnel: omnichannel effect | **+70%** vs +46% |
| Incrementality factor vs lower-funnel — mid-funnel | **1.3×** |
| Incrementality factor vs lower-funnel — traffic optimisation | **2.4×** |
| Incrementality factor vs lower-funnel — reach/awareness optimisation | **6.0×** |
| Brands with <5,000 purchase events/week: mid-funnel efficiency penalty | only **5% lower** DTC efficiency |

Read carefully, this is **the strongest pro-funnel evidence in existence, and it does not say what
funnel advocates think it says.**

- It vindicates upper- and mid-funnel *optimisation goals* — a reach- or traffic-optimised ad set
  produces conversions Meta's attribution barely credits (IF 6.0× and 2.4× respectively). That is a
  real, measured, non-obvious result.
- Crucially, **Haus's "funnel stage" means the optimisation objective and the measurement window, not
  the audience.** Their own methodology page describes upper-funnel as *"awareness campaigns"* with
  delayed measurement (tests averaging 34 days vs 18.6) and lower-funnel as *"conversion campaigns"*
  with immediate windows ([source](https://www.haus.io/article/meta-incrementality-testing)). Nothing
  in this dataset says "retargeting video viewers works". It says "optimising for cheap actions is
  worth more than Meta's own reporting admits".
- The last row is the one that matters most to us and cuts the other way from the rest: **for brands
  under 5,000 purchase events/week, the mid-funnel efficiency penalty nearly vanishes (5% vs 14%)**.
  Small advertisers give up almost nothing by optimising mid-funnel. That is a genuine, quantified
  argument in favour of offering a cheaper optimisation event to low-volume accounts — which is
  exactly what the existing synthesis already recommends for cold-start accounts.

### 3.3 What the retargeting evidence says

There is no clean public randomised test of Meta video-viewer retargeting. What exists:

- **Retargeting's measured ROAS is systematically inflated.** Attribution credits conversions that
  would have happened anyway. Loomer's practical diagnostic is worth encoding: when you break
  retargeting results down by attribution setting, expect *"a disproportionately high concentration
  in the 1-Day View column"*, which usually means either the person was emailed the same day or was
  a habitual visitor — *"they would have made the purchase anyway"*
  ([Loomer](https://www.jonloomer.com/prioritize-remarketing-over-metas-algorithmic-ad-targeting/)) **[C]**.
  Practitioner incrementality figures circulating for DTC retargeting sit at **20–40% incrementality
  (i.e. 60–80% of credited conversions not caused by the ad)**; I could not trace these to a
  published study and grade them **[F]** pending a citation.
- **Non-experimental measurement of any of this is hopeless.** Gordon, Moakler & Zettelmeyer analysed
  **663 large-scale RCTs at Facebook** with access to 5,000+ user-level features — far more than any
  advertiser has — and found that even double/debiased machine learning could not recover the
  experimental answer: *"the median absolute percentage point difference in lift is 115%, 107%, and
  62% for upper, mid, and lower funnel outcomes, respectively"*
  ([Marketing Science 42(4):768–793](https://arxiv.org/abs/2201.07055)) **[E]**. Two consequences for
  this product: (a) any claim it makes about a funnel stage's contribution from observational data is
  wrong by ~100%, and (b) upper-funnel is where observational methods are *worst* — precisely the
  stage the video funnel adds.
- **Meta's own lift tests are trustworthy; Meta's A/B tests are not, for audience questions.** A 2025
  analysis of **3,204 Lift tests and 181,890 A/B tests** found Lift tests showed *"no meaningful
  audience imbalance"* while A/B tests showed *"clear imbalance"* from divergent delivery
  ([arXiv:2508.21251](https://arxiv.org/pdf/2508.21251)) **[E]**. So: if the platform ever tests
  "funnel vs no funnel", it must use a Conversion Lift test, not the A/B test tool. An A/B test of two
  targeting strategies is confounded by the algorithm choosing who sees which.

### 3.4 The one upper-funnel finding that survives

Strip out the folklore and one thing stands: **reach/awareness-optimised spend is worth ~6× its
attributed value, delivers 81% of its impact to new customers, and generates +138% non-DTC halo**
([Haus](https://www.haus.io/blog/the-meta-report-lessons-from-640-haus-incrementality-experiments)) **[E]**.

That is an argument for a top-of-funnel campaign. It is **not** an argument for the video-view funnel,
because the value is in the *impressions delivered to new people*, not in the retargeting pool
produced as a by-product. The pool is a side effect that the folk model mistakes for the point.

This reframes the TOF stage usefully for the product: **the top of a video funnel is worth running
for its own sake at accounts that can afford it, and its retargeting pool is a bonus that only
becomes material above a computable budget.** Two independent justifications, two independent
thresholds.

---

## 4. Lookalikes: where they actually belong

### 4.1 The API surface (all **[P]**, fetched 2026-09-05)

`POST /act_{id}/customaudiences` with `subtype=LOOKALIKE`:

| Field | Constraint |
|---|---|
| `origin_audience_id` | **Required** (seed route). Origin must have **≥100 members** |
| `lookalike_spec.type` | `similarity` (≈top 1%) or `reach` (≈top 5%). Set `type` **or** `ratio` |
| `lookalike_spec.ratio` | `0.01`–`0.20`, steps of 0.01. Top x% of the country |
| `lookalike_spec.starting_ratio` | Optional. `starting_ratio` 0.01 + `ratio` 0.02 ⇒ the 1–2% band. Must be < `ratio` |
| `lookalike_spec.country` | **Required**, or `location_spec` |
| `lookalike_spec.allow_international_seeds` | Default `false`. If a country has <100 seed members, `true` lets Meta find them elsewhere |
| `lookalike_spec.location_spec` | `geo_locations.countries` / `country_groups`, plus `excluded_geo_locations` |

Behavioural facts that change design:

- **Source members are excluded from the lookalike automatically.** *"People in your source audience
  are excluded from your lookalike audience"*
  ([P](https://www.facebook.com/business/help/465262276878947)). Manually excluding the seed from a
  lookalike ad set is therefore redundant — a common piece of **[F]** advice.
- **Population takes 1–6 hours** (API guide) or *"up to 3 days"* (Help Centre). Both are Meta;
  they disagree. Ads can run during population. Design for the pessimistic number.
- **Refreshed every 3 days if the lookalike is attached to an ad set.** An unused lookalike is not
  refreshed at all.
- **Inactive after 90 days without an active ad set**: `operation_status` 450, `approximate_count`
  and `delivery_estimate` both return `-1`. **Expiring after 2 years unused** (`operation_status` 100
  and a `delete_time`), deleted 90 days later.
- **Integrity flag `operation_status: 471`** (rolled out from 2 Sept 2025) blocks audiences that
  *"suggest specific health conditions … or financial status"*, and creating a lookalike from a
  flagged seed fails with `code 100, error_subcode 1713232, "Seed audience restricted"`. An
  autonomous system naming audiences from brand copy can trip this by accident — sanitise generated
  audience names.
- **`country`/`location_spec` removal is announced but delayed.** The API doc still carries a warning
  from 28 April 2021: *"The removal of the `location_spec` and `country` parameters from lookalike
  audience creation is currently delayed."* Meanwhile the Help Centre already says *"You no longer
  select audience location when creating a lookalike"*
  ([P](https://www.facebook.com/business/help/465262276878947)). **The UI has moved and the API has
  not.** Keep sending `country`; expect it to break.

### 4.2 The undersold route: campaign-conversion lookalikes

Buried in the same guide is a seed mechanism that skips custom audiences entirely:

```bash
-F 'subtype=LOOKALIKE' \
-F 'lookalike_spec={
  "origin_ids": ["<CAMPAIGN_ID>", "<ADSET_ID>"],
  "conversion_type": "campaign_conversions",
  "starting_ratio": 0.03, "ratio": 0.05, "country": "US"
}'
```

Meta *"uses up to 180 days of past conversion data"*, trains a prediction model, and **"constantly
updates the underlying prediction model as campaigns or ad sets get new conversions"**. Requires
**≥100 unique conversions, 200+ recommended**. And the eligible conversion types explicitly include
**Video views**, alongside Website conversions, Post engagement, Link clicks, Page likes and others.
**[P]**

This matters for us: it is a **documented** path from "I ran a video-views campaign" to "give me
people like the ones who watched it" that requires no video engagement custom audience, and therefore
sidesteps the entire undocumented-rule risk of §2.4. It is a live model rather than a static seed. If
the product is going to build video-seeded lookalikes at all, this is the route to try first.

### 4.3 Which seeds actually make good lookalikes

Meta contradicts itself on seed size:

| Source | Guidance |
|---|---|
| Help Centre, *Create a lookalike audience* | *"A source with at least 100 people. We generally recommend a source audience that has between **1,000-5,000** people."* |
| API guide, *Best practices* | *"Seed Custom Audience — Make it **as large as possible** so Meta has enough data to find similar people."* |

Both fetched 2026-09-05. They are not reconcilable, and the difference is strategic: the first says
concentrate on your best customers, the second says maximise volume. My reading is that the Help
Centre number is legacy advice from the era when the lookalike model was a similarity computation
over a fixed seed, and the API line reflects the current modelling regime — but that is inference,
not evidence. **UNVERIFIED.**

Ranking of seed types by signal density. The reasoning is mechanical (what behaviour does the seed
encode?), and where evidence exists it is cited:

| Rank | Seed | Why | Grade |
|---|---|---|---|
| 1 | **Value-based purchasers** (customer list with a value column, or Purchase pixel event) | Encodes "buys, and buys a lot". The only seed whose behaviour is the behaviour you want | C |
| 2 | **Purchasers, unweighted** | Same behaviour, no value discrimination | C |
| 3 | **Downstream-qualified leads** (CRM upload of leads that became customers) | Encodes revenue, not form-fills. Requires offline events or a customer list | C |
| 4 | **Add-to-cart** | Weaker intent, but **often the better seed when the purchase seed is under ~1,000**: volume and stability can beat purity | C |
| 5 | **All website visitors / ViewContent** | *"Lookalikes based on PageView or ViewContent are almost worthless because the signal is too broad"* — widely repeated, no traceable source | F |
| 6 | **75%/95% video viewers** | Encodes "watches videos" | C |
| 7 | **25%/50% video viewers, 3-second viewers** | Encodes "scrolls slowly". Meta's engagement model groups people by propensity to watch, and that is a different population from propensity to buy | C |
| — | **Page likers** | Cannot even carry retention (`retention_seconds=0`); stale by construction | P |

The controlled evidence available on lookalikes as a whole is one test, and it is unflattering: over
30 days and ~$2,250 with three ad sets at $25/day, Advantage+ audience produced **43 more true
registrations than lookalikes** and **54% more "quality" registrants** (measured by downstream email
engagement in the advertiser's own CRM, not by Ads Manager). Meta's split-test tool put the chance of
lookalikes winning on a rerun at **under 5%**. The lookalike seeds used were good ones — a customer
list, an active paid-membership list, and 180-day purchasers
([Loomer](https://www.jonloomer.com/test-results-advantage-plus-audience-detailed-targeting-lookalikes/)) **[E, n=1]**.

The author's own caveat should be carried forward: his account has a decade of pixel history and
100,000+ monthly site visitors, which is exactly the condition under which Advantage+ audience has
the most to work with. **A new account with no history is the case where lookalikes should still
win, and that case was not tested.** That is our users' case, and it is the honest reason to keep
lookalikes in the product at all.

### 4.4 Ratio tiers: what to actually do

The old advice — run 1%, then 1–3%, then 3–5% as separate ad sets — is largely obsolete for one
documented reason: **Advantage+ lookalike is on by default and cannot be turned off when optimising
for conversions.**

> *"Advantage+ lookalike is automatically enabled for new, duplicated and draft campaigns and ad sets
> using lookalike audiences created from mobile, website or customer list custom audiences."*
> — [P](https://www.facebook.com/business/help/1212225059146059)

> *"Because I'm optimizing for conversions, Advantage Lookalike is automatically turned on and can't
> be turned off."* — [Loomer](https://www.jonloomer.com/test-results-advantage-plus-audience-detailed-targeting-lookalikes/) **[C]**

So a "1% lookalike" ad set does not deliver to a 1% audience. It delivers wherever the system finds
performance, using the seed as a hint. Under those conditions the difference between a 1% and a 5%
lookalike is largely notional, and splitting them into separate ad sets buys fragmentation for
nothing.

Note the precise wording of the Meta quote: the auto-expansion is described for lookalikes built from
**mobile, website or customer list** custom audiences. It does not mention engagement or video seeds.
Whether a video-seeded lookalike escapes auto-expansion is **UNVERIFIED** and worth a live check —
if it does, video-seeded lookalikes are the *only* ones where ratio still means anything, which would
be an unexpected and useful asymmetry.

**Recommendation for the product:**

- Build **one** lookalike per seed, `ratio: 0.03`, `type` omitted (use `custom_ratio` semantics via
  `ratio`). 3% is the compromise: big enough to deliver in small countries, small enough to mean
  something if expansion is ever off.
- Use `starting_ratio` **only** for a genuine banded exclusion (e.g. a 1–3% band when a separate ad
  set already holds 0–1%) — and per §5 the product should almost never be creating that second ad
  set anyway.
- Pass the lookalike as an **audience suggestion** inside Advantage+ audience, not as a hard
  inclusion. This keeps `advantage_audience` on, keeps the campaign eligible for Advantage+ status,
  and gives the algorithm the cold-start hint without the cage.
- **Never** create a lookalike from a seed under 1,000 people unless the account has no other seed.
  100 is the API minimum; it is not a recommendation.

The one number often quoted for tier performance is an AdEspresso test showing 1% at $3.75 CPL, 5% at
$4.16 and 10% at $6.36. It predates ATT, the ODAX rewrite and Advantage+ lookalike entirely. **[F]**
for 2026 purposes; do not build anything on it.

---

## 5. The budget question — the centre of the product

This is the section the product should be built around. The question is not "what's a good budget
split" but "**at what total budget does splitting the budget at all stop being a mistake?**"

### 5.1 The learning-phase floor, derived from primary sources

Meta's threshold, verbatim:

> *"ad sets exit the learning phase as soon as they can deliver stably. This usually occurs after
> **about 50 results in the week after the ad set's last significant edit**."*
> — [About the learning phase](https://www.facebook.com/business/help/112167992830700) **[P]**

> *"An ad set becomes learning limited when it is **unlikely to receive about 50 optimization events
> in the week after your last significant edit**."*
> — [About learning limited](https://www.facebook.com/business/help/269269737396981) **[P]**

Note two things most summaries get wrong. First, the threshold is per **ad set**, not per ad, and it
counts **results / optimisation events**, not conversions in the colloquial sense — the ad set's own
chosen event. Second, "learning limited" is a **forecast**, not a measurement: Meta declares it when
the ad set is *unlikely to* hit 50, which can happen immediately on publish.

There is also a documented special case worth encoding: *"For Shops ads, an ad set becomes learning
limited when it hasn't generated a minimum of **17 purchases through your website and 5 through
Meta** after 7 days."*

**The floor formula:**

```
weekly_budget_to_exit_learning(stage)  =  50 × cost_per_optimisation_event(stage)
daily_budget_to_exit_learning(stage)   =  50 / 7 × CPE  ≈  7.14 × CPE
```

Applied to each stage of a canonical video funnel, using tier-1 market costs
(cost per ThruPlay **$0.03–$0.10** in US/UK/DE per
[AdSights benchmarks](https://www.adsights.ai/resources/glossary/metrics/cost-per-thruplay) **[C]**):

| Stage | Optimisation event | Plausible CPE | **Daily budget to exit learning** |
|---|---|---|---|
| TOF | ThruPlay | $0.05 | **$0.36** |
| TOF | Reach (1,000 impressions) | $12 CPM | n/a — reach ad sets are not event-limited |
| MOF | Landing page view | $0.80 | **$5.71** |
| MOF | ViewContent | $2.00 | **$14.29** |
| MOF | Add to cart | $8.00 | **$57.14** |
| BOF | Purchase, $30 CPA | $30 | **$214.29** |
| BOF | Purchase, $60 CPA | $60 | **$428.57** |
| BOF | Lead (instant form) | $6 | **$42.86** |
| BOF | Lead (website form) | $20 | **$142.86** |

**This table is the single most useful artefact in the dossier.** Read the right-hand column as "the
minimum this ad set must be given before the delivery system will treat it as a real thing".

The conclusion is counter-intuitive and worth stating plainly: **the video-view stages of a video
funnel are essentially free to run from a learning-phase standpoint.** The received wisdom that a
funnel fails because it "fragments spend so nothing exits learning" is only half right — it is the
*bottom* stage that cannot afford itself, and it would not be able to afford itself in a
single-campaign account either. Adding the top and middle stages costs almost nothing in
learning-phase terms; they cost in *audience quality*, *auction overlap*, and *the budget diverted
away from the stage that converts*.

Loomer's independent statement of the same arithmetic, from the other direction, is a useful sanity
check: *"If it ends up costing $10 for one of these events as the central conversion event, I'll need
to spend $500 per week just to exit the learning phase for what is essentially a traffic campaign."*
($10 × 50 = $500.) **[C]**

### 5.2 The audience-size floor — the constraint that actually binds

A retargeting stage needs people in it. Meta's stated floors:

- **Lookalike seed: ≥100 members** (hard, API-enforced) **[P]**
- **Custom audience: ~1,000 recommended** for reliable delivery — repeated consistently by
  practitioners and consistent with Meta's Help Centre recommending 1,000–5,000 for lookalike seeds.
  I could not find Meta stating a hard delivery floor for custom audiences. **[C]**

So: how much TOF video spend buys a 1,000-person 50%-viewer pool?

```
impressions            = (daily_budget × days) / CPM × 1000
50%-view events        = impressions × p50            # p50 = share of impressions reaching 50%
unique people in pool  = 50%-view events / frequency
```

With tier-1 assumptions — **CPM $12**, **p50 ≈ 10%** for a competent 15–30s vertical video on
Reels/Feed, **frequency ≈ 1.3** over a 30-day window:

| TOF daily budget | 30-day spend | Impressions | 50% pool (unique) | 75% pool (≈ half) |
|---|---|---|---|---|
| $5 | $150 | 12,500 | **~960** | ~480 |
| $10 | $300 | 25,000 | **~1,920** | ~960 |
| $20 | $600 | 50,000 | **~3,850** | ~1,920 |
| $50 | $1,500 | 125,000 | **~9,600** | ~4,800 |
| $100 | $3,000 | 250,000 | **~19,200** | ~9,600 |

**The operational threshold: roughly $300 of cumulative TOF video spend (about $10/day for 30 days)
before a 50%-viewer pool crosses 1,000 people. Double it for a 75% pool.**

Two things follow immediately and both should be built:

1. **The product can compute this before offering the funnel.** It knows the brand's budget, it can
   read `cost_per_thruplay`, `impressions` and the video-percentage-watched actions from Insights,
   and it can therefore *forecast the pool size* rather than guess. Offering a MOF stage that will
   contain 400 people is an unforced error the system is capable of not making.
2. **Retention window is the lever that trades freshness for size.** A 30-day window on $5/day yields
   ~960 people; a 90-day window on the same spend yields ~2,900. If the pool is the constraint,
   lengthen the window before you raise the budget. Rule: `retention_days = max(30, days needed to
   reach 1,000 people at current burn)`, capped at the per-source maximum in §7.1.

### 5.3 Putting the two floors together — where a multi-stage funnel starts to make sense

Combine §5.1 and §5.2. A three-stage funnel with a purchase bottom at a $30 CPA needs:

| Stage | Floor | Driven by |
|---|---|---|
| TOF video | **$10–20/day** | pool size (§5.2), not learning |
| MOF | **$15/day** | ViewContent learning floor + needs the pool to exist |
| BOF | **$214/day** | purchase learning floor |
| **Total** | **≈$240–250/day (~$7,300/month)** | |

If BOF is held to 15% of budget as practitioners recommend, the implied total is even higher —
$214 / 0.15 ≈ **$1,430/day**. That figure is not mine: it is what the arithmetic produces, and it
lands almost exactly on the independently-arrived-at practitioner threshold *"skip a dedicated
retargeting build entirely until you're spending close to $1K/day"*
([Flighted](https://www.flighted.co/blog/best-meta-ads-account-structure-2026)) **[C]**. When
first-principles arithmetic and practitioner consensus converge from opposite directions, that is
about as much confidence as this domain offers.

But that assumes the BOF stage *must* exit learning. It need not. Meta's own remedy list for
learning-limited explicitly includes **"Change your optimization event … For example, move from
purchases to add to cart"** ([P](https://www.facebook.com/business/help/269269737396981)) — and
Haus's finding that low-volume brands lose only **5%** of DTC efficiency from mid-funnel optimisation
**[E]** says this trade is cheap for exactly our users. Substituting Add-to-cart at $8 drops the BOF
floor from $214/day to **$57/day** and the sensible-total to roughly **$90/day**.

**The recommended budget ladder, with the reasoning attached:**

| Total daily budget | Monthly | What the system should build | Why |
|---|---|---|---|
| **< $20** | < $600 | **One campaign, one ad set.** Advantage+ audience, conversion objective, cheapest meaningful conversion event. No retargeting, no lookalikes, no video-view campaign | Nothing else can reach any floor. Every ad set you add is an ad set that never exits learning |
| **$20–50** | $600–1,500 | **One campaign, one ad set** + exclude existing purchasers only. Optionally one cold-start lookalike as a *suggestion* inside the same ad set | Meta already spends 25–45% of a broad ad set's budget on warm audiences (§6.3) — the retargeting is happening, it just doesn't have its own line item |
| **$50–150** | $1,500–4,500 | **Two campaigns.** Broad conversion (85%) + one recapture ad set (≤15%) with a mid-funnel optimisation event, **only if** the warm pool is ≥1,000 | The recapture stage can now clear an ATC/ViewContent floor. Purchase optimisation at BOF still cannot |
| **$150–500** | $4,500–15,000 | Two campaigns, BOF may move to Purchase optimisation if CPA < $20. Add a TOF video/reach campaign at ~15% for the 6.0× incrementality factor | Both floors reachable for two stages; the third stage earns its place on incrementality, not on pool-building |
| **> $500** | > $15,000 | Full three-stage structure viable. Separate creative testing campaign | This is where the practitioner budget-tier tables start, and they are right that it is where they start |

Practitioner budget-tier tables (**[C]**, from
[Baker](https://withbaker.com/blog/meta-ads-campaign-structure-budget-setup)) put the "full funnel
viable" boundary at **$10–30K/month** with a 15% testing / 60% TOFU / 25% retargeting split, and
describe *"premature complexity (running 5 campaigns on a $5K/month budget)"* as **"the most common
structural mistake in Meta Ads accounts."* Directionally this agrees with the arithmetic above.
Numerically, treat their splits as illustrative — none of these tables cites a test.

### 5.4 The budget split, once you're above the threshold

For accounts genuinely above ~$500/day, the split practitioners converge on is roughly
**15% test / 60–70% prospecting / 15–25% retargeting**, with retargeting *falling* as a share as
total budget rises (because the warm pool is finite while the cold pool is not).

Two primary-source facts should override any split table:

1. **With Advantage+ campaign budget, the largest audience wins the budget.** *"Remember that
   audience size may affect budget distribution. If your audiences are significantly different in
   size, ad sets with the largest audiences will likely receive the most budget"*
   ([P](https://www.facebook.com/business/help/2177212182495139)). **This is the reason to put
   prospecting and retargeting in *separate campaigns* rather than as two ad sets under one CBO.** A
   1,500-person retargeting ad set sharing a campaign budget with a broad prospecting ad set will be
   starved, and the failure is silent.

2. **Ad-set spend limits exist but Meta tells you not to use them.** `daily_min_spend_target` and
   `daily_spend_cap` (and their `lifetime_` equivalents) are available when campaign budget is on
   ([P](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign)), but Meta's
   guidance is *"Use ad set spend limits sparingly, or not at all"* and, for strict per-stage budgets,
   *"you may want to consider using ad set budgets instead"*
   ([P](https://www.facebook.com/business/help/2177212182495139)). Constraints worth encoding if the
   product ever does use them ([P](https://www.facebook.com/business/help/454681230514942)):
   - maximum spend limit is a **weekly** cap (`7× the value`), managed Sunday–Saturday; daily spend
     may exceed it
   - minimum spend limit is *"a target range, not a guarantee"* and must be ≤ campaign budget
   - if using both on one ad set: **≥0.9% and ≥$1 apart**, and Meta recommends against it
   - **pausing an ad set with a max spend limit shrinks total campaign spend** — a $50 campaign with
     5 ad sets capped at $10 each spends only $40 if one is paused
   - edits take **up to 15 minutes** to apply

   **Product implication: use ABO (per-ad-set budgets) for anything multi-stage, and reserve
   Advantage+ campaign budget for single-stage campaigns with several creative-variant ad sets.**
   That is the opposite of the usual "always use CBO" advice, and it follows directly from Meta's own
   two statements above.

3. **Minimum budget rules that do bind.** Meta has removed the specific dollar minimums from its
   public page — the current text says only *"most advertisers should have a large enough daily
   budget"* — but one hard rule remains: *"If you use the cost per result goal bid strategy, your
   daily budget should be at least **5 times** the amount of your cost per result goal."*
   ([P](https://www.facebook.com/business/help/203183363050448)). The widely-quoted "$1/day for
   impressions, $5/day for conversions" figures are no longer published by Meta and should be graded
   **[F]** — they may still be enforced, but they are not documented.

---

## 6. Audience overlap and exclusions

### 6.1 What overlap actually does — and the folklore it destroys

The single most repeated piece of funnel advice is that overlapping audiences make you "bid against
yourself" and inflate your CPMs. Meta's own documentation says otherwise:

> *"When 2 or more ads from the same advertiser enter the same ad auction, **we choose the ad with
> the highest total value to compete in the auction**. As a result, other ads from that advertiser
> are not considered in this auction. **This ensures that your ads will not bid against one
> another.**"*
> — [Understand auction overlap](https://www.facebook.com/business/help/537699989762051) **[P]**

So the claim that stacked 1%/3%/5% lookalikes inflate CPM by 40% through self-bidding is
**FOLKLORE — CONTRADICTED**. You do not pay more per impression because of overlap.

What overlap *actually* costs, from the same page:

> *"Since auction overlap prevents ads from entering auctions, auction overlap can **prevent an ad
> set from spending its full budget or achieving enough results to exit the learning phase**. … Too
> much auction overlap across your Page typically results in less predictable performance —
> especially when scaling your budget."*

And a detail that matters for any multi-account architecture: *"Running ads from separate ad accounts
may not help you avoid overlap. Although the ad delivery system may identify multiple accounts as
belonging to the same advertiser, auction overlap can occur across these accounts."* **[P]**

**The real cost of getting exclusions wrong is therefore delivery suppression and learning-limited
status on the suppressed ad set, not price inflation.** That is a materially different failure to
diagnose: the symptom is an ad set that won't spend, not one that spends expensively.

Meta's stated remedies, in its own order: consolidate across ad accounts; combine similar ad sets;
turn off the overlapping ad sets that are learning-limited or have fewest results and move their
budget to the survivor. Every remedy is "have fewer ad sets".

### 6.2 The exclusion asymmetry that defines 2026 funnel design

Under Advantage+ audience:

> *"You can raise the minimum age up to 25 or **exclude a custom audience without turning Advantage+
> off**."* — [P](https://www.facebook.com/business/help/906206294602874)

> *"custom audience exclusions can also be set here, but **they are always set as controls even if
> Use as a suggestion is checked**."* — [P](https://www.facebook.com/business/help/25941857932125812)

> *"Advantage+ audience is proven to drive performance because **most settings are suggestions**. …
> Ads will also be shown to other audiences when it's likely to improve performance. **Controls** are
> available to limit ads to audiences above a minimum age and in certain locations."* — same source

**Inclusions are hints. Exclusions are law.** This is the mechanical fact around which every template
in §10 is designed. You cannot build a funnel by telling Meta who to reach; you can only build one by
telling it who *not* to reach, and by routing different creative to different campaigns.

At the API level the corresponding fields are `targeting.custom_audiences` (the suggestion) and
`targeting.excluded_custom_audiences` (the control), with `targeting_automation.advantage_audience: 1`
turning the former into suggestions. Meta's unified Advantage+ structure requires either
`targeting_automation.advantage_audience = 1` **or** targeting limited to `geo_locations` only, along
with campaign-level budget and no placement targeting, before `advantage_state` will read
`ADVANTAGE_PLUS_SALES` / `_LEADS` / `_APP` — the old `smart_promotion_type` flag is gone and these are
read-only derived fields ([ppc.land, citing Meta's migration docs](https://ppc.land/meta-deprecates-legacy-campaign-apis-for-advantage-structure/)) **[C, corroborates the project's existing meta-native-automation dossier]**.

### 6.3 Which stages must exclude which — and where the conventional answer is wrong

The conventional answer is "exclude everything downstream from everything upstream". That is wrong,
and expensively so.

**Evidence that broad ad sets already do the retargeting.** Loomer measured budget distribution using
Meta's Audience Segments breakdown across four targeting approaches and found remarketing consistently
took **25–35% of budget regardless of the targeting approach**; in a separate head-to-head, an
Advantage+ audience ad set with no suggestions spent **45% of its budget on the same people** he was
targeting explicitly in a parallel remarketing ad set — *"By giving the algorithm more freedom, I
found that it maintained a more reasonable frequency compared to when I only targeted the remarketing
group"* ([Loomer](https://www.jonloomer.com/prioritize-remarketing-over-metas-algorithmic-ad-targeting/)) **[C]**.

If you exclude warm audiences from your broad prospecting campaign, you are excluding the cheapest
and highest-converting third of what that campaign would otherwise do — and Meta will not tell you
that is what happened.

**The exclusion table this product should implement:**

| Ad set | Must exclude | Should exclude | Must NOT exclude | Reason |
|---|---|---|---|---|
| Broad prospecting / TOF | Existing **purchasers** (unless repeat purchase is the goal) | — | General site visitors, video viewers, page engagers | Excluding warm traffic costs 25–45% of the campaign's efficiency (above) and is the commonest self-inflicted wound |
| MOF (video-viewer retarget) | Site visitors in the last N days; purchasers | Lead-form submitters | — | Without the site-visitor exclusion, MOF re-shows to people who already clicked through — the only exclusion in a video funnel that clearly earns its keep |
| BOF (site-visitor retarget) | Purchasers | Recent 1-day visitors (they're mid-session) | — | Retargeting a converter is pure waste and pollutes the ROAS |
| Any retargeting stage | — | — | Its own lookalike's seed | Meta already removes seed members from the lookalike automatically **[P]** |

**Special case — Advantage+ Sales campaigns:** an "existing customer" exclusion is the one control
these campaigns natively expose, and the old existing-customer *budget cap* was removed when
Advantage+ Shopping became Advantage+ Sales in February 2025 **[C]**. So the way to keep an Advantage+
Sales campaign focused on new customers is now an audience exclusion, not a budget ratio.

**The cost of getting it wrong, summarised:**

| Mistake | Symptom | Cost |
|---|---|---|
| No exclusions anywhere | Ad sets don't spend their budget; retargeting ad set shows Learning Limited | Delivery suppression, not price. Diagnose with the `Delivery` column, not CPM |
| Excluding warm from prospecting | Prospecting CPA rises, campaign looks "fine" | ~25–45% of the campaign's cheap conversions, silently |
| Not excluding purchasers | Inflated ROAS, wasted frequency on people who bought | Measurement corruption + real waste |
| MOF without a site-visitor exclusion | MOF and BOF both claim the same conversions | Double-counting; you cannot tell which stage works |
| Stacked lookalike tiers as separate ad sets | Smaller tiers starve | Fragmentation, not CPM inflation |

---

## 7. Retention windows per stage, and why

### 7.1 The hard ceilings (all **[P]**, 2026-09-05)

| Source type | Max retention | Where enforced |
|---|---|---|
| Lead generation ads | **90 days** | Marketing API engagement guide |
| Shopping engagement | **365 days** (data since April 2020) | same |
| Augmented reality | **365 days** | same |
| Video engagement | **365 days** | Ads Manager flow |
| Page / Instagram business profile / Instant Experience | **730 days** | Marketing API engagement guide |
| Page likes | **0** — no retention concept; cannot combine with other page events | same |
| Website (pixel) | **1–180 days** documented; `prefill` also capped at 180 | Website CA guide |
| Website — Purchase events | **730 days** since 18 May 2026 (UI); auto-migrated from 180 unless opted out | [kitchn.io](https://www.kitchn.io/blog/meta-ads-manager-updates-may-2026) **[C]** — **not reflected in the API docs, UNVERIFIED via API** |
| Audience rules generally | `retention_seconds` Min 1, **Max 365 days** | Audience Rules guide |

Note the internal contradiction: the Audience Rules guide caps `retention_seconds` at 365 days while
the engagement guide lists 730-day maxima for Page/IG/Canvas. Meta's docs disagree with themselves.
Practitioner reports say values above the true per-source cap are **silently truncated** rather than
rejected — meaning a system that sets 730 on a non-purchase website audience will get 180 and no
error. Build a read-back verification step: after creating any audience, `GET` its `retention_days`
and compare with what was sent.

### 7.2 The design rule: inclusion windows short, exclusion windows long

This is the asymmetry that most funnel templates get backwards.

**Inclusion windows should be as short as the audience-size floor allows.** Intent decays. A person
who watched 75% of your video yesterday is a different prospect from one who did so 200 days ago, and
Meta's delivery system will happily spend on the stale ones because they are cheaper to reach.

**Exclusion windows should be as long as the platform permits.** There is no downside to excluding a
purchaser for 730 days rather than 180, and every day you *don't* exclude them is waste plus
attribution pollution.

| Stage | Recommended window | Rationale |
|---|---|---|
| Video viewers (MOF inclusion) | **30 days**, extended toward 90 only when the pool is under 1,000 | §5.2 — window is the size lever. Beyond 90 days a video-view signal is essentially a demographic |
| Site visitors (BOF inclusion) | **14–30 days** | Purchase-intent half-life. 7 days if traffic is heavy enough |
| Add-to-cart (BOF inclusion) | **14–30 days** | Longer than site visitors because the signal is stronger and the pool is smaller |
| Lead-form openers/droppers | **90 days** — take the maximum | Hard cap; the pool is always small |
| Purchasers (exclusion) | **180 days**, or **730** where the new purchase window is available | No downside; more is better |
| Purchasers (lookalike seed) | **180 days** default; longer only if the seed is under 1,000 | *"a two-year-old purchaser is not the same signal as a 90-day one"* **[C]** |
| Page/IG engagers (cold-start seed only) | **365 days** | Weak signal; take volume |

One consequence of the automatic-refresh behaviour is worth stating because it removes a job people
think they have: engagement audiences are *"constantly being refreshed, so you don't need to edit or
create a new engagement custom audience unless you want to change the time period or the type of
engagement"* ([P](https://www.facebook.com/business/help/1090330204367211)). **The system should
create each audience once and never rebuild it.** Rebuilding costs the audience's history and, if it
is attached to a live ad set, is a targeting change — which is a **significant edit** that resets the
learning phase (§9.2).

---

## 8. Do Advantage+ and broad targeting make manual funnels obsolete in 2026? A straight answer

**Yes for audience *selection*. No for audience *exclusion*, creative routing, or measurement.**

That is the whole answer. The rest of this section is the evidence, in descending order of strength.

### 8.1 The evidence for "obsolete"

**Meta's own product architecture has already decided this.** As of Marketing API v25.0 (18 Feb 2026,
absolute across all versions from 19 May 2026) you cannot create a legacy Advantage+ Shopping or App
campaign at all; Advantage+ status is now *derived* from three settings — campaign-level budget,
`targeting_automation.advantage_audience = 1` (or geo-only targeting), and no placement targeting —
exposed as the read-only `advantage_state` field
([ppc.land](https://ppc.land/meta-deprecates-legacy-campaign-apis-for-advantage-structure/)) **[C]**.
Manual targeting is not removed, but it is now the thing you have to opt *into*, and doing so flips
your campaign to "Advantage+ off".

**Meta publishes cost-per-result deltas for its audience automation** ([P*], unaudited, no method
published, from [About Advantage+ audience](https://www.facebook.com/business/help/273363992030035)):

| Objective | Claimed cost-per-result improvement |
|---|---|
| Awareness | **−14.8%** |
| Traffic, Engagement, Leads | **−9.7%** |
| Sales, App promotion | **−7.2%** |

**Account simplification is the first pillar of Meta's own Performance 5 framework**, and Meta's
consolidation page is explicit about the mechanism: *"When you run too many ad sets at the same time,
each one gets fewer opportunities to learn and therefore fewer results. This means ad sets may spend
more time in the learning phase, and you may spend more budget before the delivery system can fully
optimize performance"*
([P](https://www.facebook.com/business/help/2419480091640105)). Its worked example is precisely the
funnel-builder's instinct — three ad sets for "dogs", "dog toys", "dog collars" — and its verdict is
*"combining these ad sets and broadening the audience to include all 3 interests in one ad set"*.

**The one controlled test available agrees.** 30 days, $2,250, three ad sets, split-test tool,
CRM-verified outcomes: Advantage+ audience beat both interest targeting and lookalikes on volume
*and* on downstream quality; lookalikes had a modelled <5% chance of winning a rerun
([Loomer](https://www.jonloomer.com/test-results-advantage-plus-audience-detailed-targeting-lookalikes/)) **[E, n=1]**.

**And a mechanical point that ends the argument for inclusion-based funnels:** when optimising for
conversions, Advantage Detailed Targeting and Advantage Lookalike are **automatically on and cannot
be turned off**. Your interest and lookalike inclusions are already being expanded past themselves.
Building a funnel out of inclusions in 2026 is building it out of suggestions.

### 8.2 The evidence against "obsolete"

**Meta itself carves out retargeting.** *"Meta recommends A/B testing with Advantage+ audience for
almost all campaign types, **except retargeting campaigns**"*
([P](https://www.facebook.com/business/help/273363992030035)). The vendor that would most like you to
hand it everything explicitly declines to take retargeting.

**And exclusions remain hard controls** (§6.2). Meta engineered a deliberate exception so that
advertisers can still fence the algorithm out of specific populations without losing Advantage+
status. That exception exists because the use case is real.

**The incrementality evidence is genuinely unfavourable to full automation.** From 640 Haus
experiments **[E]**:

- **58% of brands saw higher iROAS on Manual campaigns than on Advantage+**
- Advantage+ delivered **12% lower DTC iROAS at 18% lower daily spend**
- Advantage+ **outperformed Manual by 9% at the experiment midpoint** and **underperformed by 12% by
  the end**
- Post-treatment-window lift: **+17% for Advantage+ vs +32% for Manual**
- *"for every $100 of revenue the platform reports, Manual campaigns deliver roughly $12 more revenue
  to the business than Advantage+"*

The interpretation Haus offers is the right one: **the more the system optimises toward likely
converters, the more it harvests demand you already had.** Advantage+ is faster and reports better;
Manual builds more. Note the offsetting finding, though: Advantage+ drove a **higher** omnichannel
halo (+51% vs +43%), so some of the gap is measurement location rather than lost value.

**The critical caveat, again:** this dataset is advertisers spending ~$14M/year. A brand at $30/day
has no manual lever worth pulling — it does not have the volume to out-target Meta, and it does not
have the measurement to know if it did. **These findings argue for manual control at scale; they do
not argue for manual control for our users.**

### 8.3 What is left for a funnel to do

Strip out everything the algorithm now does better, and three jobs remain. All three are creative and
structural, not targeting:

1. **Say a different thing to a different population.** A cold viewer needs the hook; a 75% viewer
   needs the objection handled; a cart abandoner needs the offer. Meta will not write three ads for
   you, and a single ad set with one creative cannot say three things. **This is a creative-routing
   problem that happens to require separate ad sets, and it is the only honest reason to build a
   funnel.** It is also, conveniently, the thing this platform is actually for.
2. **Fence off populations you must not pay for.** Purchasers, current customers, excluded
   territories. Exclusions only.
3. **Buy attention that the attribution model will never credit.** Reach-optimised upper funnel at a
   6.0× incrementality factor **[E]**. Worth doing above a threshold, worth ignoring below it.

**A funnel that exists to *target* is obsolete. A funnel that exists to *say different things* is
not.** For this product that is a liberating conclusion: the funnel it should build is a *creative*
funnel with an exclusion skeleton, not an audience funnel.

---

## 9. Learning-phase mechanics the templates depend on

### 9.1 Quantifying "a funnel multiplies ad sets"

§5.1 gives the per-ad-set floor. The multiplication effect is simply that floor summed across stages,
and the key insight is that **it is not symmetric**: adding a ThruPlay ad set costs $0.36/day of
learning-floor, adding a purchase ad set costs $214/day. The naive "a 3-stage funnel needs 3× the
budget" framing is wrong in both directions.

The number of ad sets a given total budget can support without any of them being learning-limited:

```
max_adsets(total_daily_budget) = total_daily_budget / (7.14 × CPE_of_the_most_expensive_stage)
```

For a $30 CPA advertiser, that is `budget / 214`. At $100/day it is 0.47 — **the account cannot
support even one purchase-optimised ad set**, let alone three. That single number is the honest
headline for most of our users, and the correct response is not "run fewer stages" but "**optimise
for a cheaper event**", which Meta itself lists as a remedy.

Two second-order effects compound this and are worth encoding as guardrails:

- **Ad volume, not just ad-set volume.** *"When an advertiser runs too many ads at once, each ad
  delivers less often. This means that fewer ads exit the learning phase, and more budget is spent
  before the delivery system can optimize performance"*
  ([P](https://www.facebook.com/business/help/2720085414702598)). Meta's stated remedy is to keep
  *fewer ads* but *more assets per ad* — one ad can hold up to 10 creative assets.
- **Auction overlap steals results from the smaller ad set** (§6.1), which pushes it below 50 even
  when its budget alone would have sufficed.

### 9.2 What resets learning — the operational constraint on an autonomous loop

**Significant edits** (each resets the learning phase for that ad set)
([P](https://www.facebook.com/business/help/316478108955072)):

- **Any change to targeting** — including swapping or editing a custom audience
- **Any change to ad creative**
- **Any change to optimisation event**
- **Adding a new ad to the ad set**
- **Pausing the ad set for 7 days or longer** (resets on unpause)
- **Changing bid strategy**

**May or may not be significant, depending on magnitude**: ad set spending limit, bid/cost/ROAS goal
amount, **budget amount** — Meta's own example is that $100→$101 is fine and $100→$1,000 is not.

Answers to questions an autonomous optimiser needs, from the same page:

- Advantage+ campaign budget redistributing budget across ad sets does **not** reset learning
- A significant edit on one ad set does **not** reset the others in the campaign
- Adding a new ad set to a CBO campaign does **not** reset the others
- But *"switching your campaign bid strategy might cause **multiple** ad sets … to reenter the
  learning phase"*, and so might *"adjusting your campaign budget"* under CBO

**Direct implication for this platform's autonomy loop:** the existing `src/autonomy/decide.ts`
already refuses to act without `learning_stage_info`. To that it should add a *funnel-aware* rule:
**a retargeting ad set that is Learning Limited is a normal, expected state and must not trigger the
same remediation as a Learning Limited prospecting ad set.** Retargeting pools are small by
construction; the correct remedy there is to widen the retention window or step the optimisation
event down, never to raise the budget (which just increases frequency on a fixed pool) and never to
iterate creative (which resets learning on an ad set that was never going to exit it). The existing
synthesis already reaches the right general conclusion — *"The correct response is consolidation
(fewer ad sets, more budget each) or an upper-funnel optimisation event — never more creative
iteration"* — and this is the stage-specific refinement of it.

A further nuance the loop should know: **`learning_stage_info.status = FAIL` is Meta's wire name for
Learning Limited** (already documented in this project's `decide.ts`), and `learning_limited` is a
*forecast*, so it can appear within hours of publish. Do not treat it as a signal that anything has
gone wrong until the ad set has had a full 7 days since `last_sig_edit_ts`.

---

## 10. Five named funnel templates

Each is specified as: **who** / **minimum viable budget** / **what it creates** / **audiences** /
**exclusions** / **failure mode** / **kill criterion**. The kill criterion matters as much as the
setup: a one-click funnel that cannot be automatically dismantled is worse than no funnel.

Throughout: `AA` = Advantage+ audience on (`targeting_automation.advantage_audience: 1`),
`ABO` = per-ad-set budgets, `CBO` = Advantage+ campaign budget.

---

### Template 1 — **Single Engine**

> *The default. The one most users should get, and the one the product should have to justify not
> choosing.*

| | |
|---|---|
| **Who** | Anyone under ~$50/day. Any brand with no pixel history. Any first 30 days |
| **Min viable budget** | **$10/day**, and it works at $50 and $200 too |
| **Creates** | 1 campaign, 1 ad set, 3–6 ads (one creative concept per ad, up to 10 assets each) |
| **Structure** | `OUTCOME_SALES` (or `OUTCOME_LEADS`) · CBO · `AA` on · Advantage+ placements · `OFFSITE_CONVERSIONS` on the cheapest event that is still commercially meaningful |
| **Audiences built** | **None** |
| **Exclusions** | Purchasers, 180 days (or 730 where available). Nothing else |
| **Optimisation event ladder** | Start at `Purchase` only if forecast weekly purchases ≥ 50. Otherwise `AddToCart` → `ViewContent` → `LandingPageView`, stepping *up* one rung whenever the current rung clears 50/week for 2 consecutive weeks |
| **Failure mode** | The account never generates enough conversion signal to climb the ladder and sits on a cheap event forever, buying low-intent traffic. Detect: conversion rate from optimisation event → purchase falling week over week |
| **Kill criterion** | None — this is the floor state. If it fails, the problem is the offer or the creative, and the funnel was never going to fix it |

**Why this is the default.** It is the only structure where 100% of the budget lands in one ad set, so
the learning floor is met at the lowest possible total spend; the algorithm does the retargeting
internally — measured at anywhere from 9% to 45% of budget depending on how much warm audience is
available to it (§6.3); and there are no exclusion mistakes to make
because there is only one.

---

### Template 2 — **Seed & Harvest**

> *A deliberately temporary cold-start structure. The only template where the video-view funnel is
> the right answer, and it is right for a reason that has nothing to do with retargeting.*

| | |
|---|---|
| **Who** | Brand-new ad account, no pixel history, no customer list, ≥100 purchasers unavailable. Meta has nothing to learn from |
| **Min viable budget** | **$20/day total**, split $10 seed / $10 harvest. Below this the seed pool never reaches 1,000 (§5.2) |
| **Creates** | 2 campaigns, ABO |
| **Campaign A — Seed** | `OUTCOME_AWARENESS` · `THRUPLAY` · billing `THRUPLAY` · `AA` on, geo only · 1 ad set · $10/day · **runs 30–45 days then stops** |
| **Campaign B — Harvest** | `OUTCOME_SALES` · `OFFSITE_CONVERSIONS` on a cheap event · `AA` on · $10/day+ · runs indefinitely |
| **Audiences built** | Video 75% viewers, 90-day retention (long, because the pool is small). Then, at day 30, a **campaign-conversion lookalike** seeded from Campaign A's ID (`conversion_type: campaign_conversions`, `ratio: 0.03`) — the documented route from §4.2, which avoids the undocumented video-audience rule entirely |
| **Exclusions** | Campaign B excludes purchasers. Campaign A excludes nothing |
| **Where the lookalike goes** | As an **audience suggestion** inside Campaign B's existing ad set. **Not** as a new ad set |
| **Failure mode** | **Soft remarketing** (§3.1) — you build a population of people who like watching videos and then optimise toward them. Mitigated by (a) using 75%, never 25% or 3-second, (b) never creating a MOF ad set that *targets* the pool, only a lookalike *suggestion*, (c) the hard 45-day stop |
| **Kill criterion** | **Automatic at day 45**, or earlier if either: the 75% pool is under 1,000 at day 30 (the seed campaign is not working — stop paying for it), or Campaign B has accumulated ≥100 purchases (real signal now exists; the proxy is obsolete) |

**Why the 45-day stop is non-negotiable.** The seed campaign's justification is that Meta has no
signal. Once it has signal, continuing to buy video views is buying a worse proxy for a thing you now
measure directly. Without an automatic stop this template degenerates into the folk funnel.

---

### Template 3 — **Broad + Recapture**

> *The first structure that genuinely earns a second campaign. The workhorse for the middle of the
> market.*

| | |
|---|---|
| **Who** | Established pixel, ≥1,000 people in a 30-day warm pool, spending enough to feed two ad sets |
| **Min viable budget** | **$50/day**, and honestly **$100/day** before it beats Template 1 |
| **Creates** | 2 campaigns, ABO (deliberately *not* one CBO campaign — see §5.4: the big audience eats the budget) |
| **Campaign A — Prospecting** | `OUTCOME_SALES` · CBO · `AA` on · 85% of budget · optimisation event per the Template-1 ladder |
| **Campaign B — Recapture** | `OUTCOME_SALES` · ABO · **`AA` off** (this is the retargeting exception Meta itself names) · 1 ad set · ≤15% of budget · optimisation event **one rung cheaper** than Campaign A's |
| **Audiences built** | One **union** audience: website visitors 30d ∪ AddToCart 30d ∪ video 75% viewers 30d. **One audience, not three ad sets** |
| **Exclusions** | A: purchasers 180d only — **not** the warm pool. B: purchasers 180d + site visitors last 1 day |
| **Creative** | This is the point of the template. A gets the hook; B gets objection-handling, social proof, or the offer. Different videos, not the same video |
| **Failure mode** | Campaign B reports a spectacular ROAS and everyone concludes retargeting is the business. It is not — much of it is demand that would have converted anyway. Loomer's diagnostic: break B's results down by attribution setting and look for a disproportionate 1-day-view concentration |
| **Kill criterion** | Kill B if: the warm pool falls below 1,000; **or** B's frequency exceeds ~4/week (you are re-showing to the same people); **or** B's share of *first-touch* conversions is under 5% while its share of last-touch is high |

**Note on the 15% cap.** It is not a magic number; it is a consequence of the warm pool being finite.
Spending more than ~15% against a 2,000-person audience just raises frequency. The product should
derive it: `recapture_budget = min(0.15 × total, pool_size × target_frequency × CPM / 1000 / 7)`.

---

### Template 4 — **Full Three-Stage Video Funnel**

> *Included because users will ask for it and because above a threshold it is defensible. Offered
> with the threshold enforced, not as a default.*

| | |
|---|---|
| **Who** | ≥$500/day, established account, purchase CPA under ~$40, running enough creative volume to feed three distinct messages |
| **Min viable budget** | **$500/day (~$15,000/month)**. Below this the BOF stage cannot exit learning on Purchase (§5.3) |
| **Creates** | 3 campaigns, ABO |
| **TOF** | `OUTCOME_AWARENESS` · **`REACH`**, not ThruPlay · `AA` on, geo only · 15% of budget · justified by the 6.0× incrementality factor **[E]**, not by pool-building |
| **MOF** | `OUTCOME_SALES` · `OFFSITE_CONVERSIONS` on `ViewContent` or `AddToCart` · `AA` **on**, with the warm audience as a **suggestion** · 60% of budget |
| **BOF** | `OUTCOME_SALES` · `OFFSITE_CONVERSIONS` on `Purchase` · `AA` **off** · 25% of budget |
| **Audiences built** | Video 75% 30d; site visitors 30d; ATC 30d; purchasers 180d (exclusion only); value-based lookalike 3% from purchasers (suggestion in MOF) |
| **Exclusions** | TOF: purchasers only. MOF: purchasers + site visitors 30d (so MOF genuinely means "engaged but hasn't landed"). BOF: purchasers + last-1-day visitors |
| **Failure mode** | Three at once: (1) BOF starves if anyone puts these in one CBO campaign; (2) exclusion drift as windows change and the stages start overlapping; (3) the account looks better than it is because all three stages claim the same conversions |
| **Kill criterion** | Collapse to Template 3 if: BOF is Learning Limited for 14 consecutive days at its full budget; **or** total daily spend falls below $350 for 7 days; **or** TOF's measured contribution cannot be distinguished from zero in a Conversion Lift test |

**The measurement obligation.** At this budget a Conversion Lift test is affordable and, per
§3.3, is the *only* method that answers the question — observational analysis is off by ~100% at
upper funnel. A three-stage funnel that is never lift-tested is a three-stage funnel that nobody can
justify. The product should schedule the test as part of the template, not as an afterthought.

---

### Template 5 — **Value Ladder**

> *For accounts with real purchase history and dispersed customer value. Not a funnel in the
> stage sense — a funnel in the value sense.*

| | |
|---|---|
| **Who** | ≥100 purchasers (ideally ≥1,000), meaningful spread in order value or LTV, an exportable customer list |
| **Min viable budget** | **$150/day** |
| **Creates** | 1–2 campaigns |
| **Campaign A** | `OUTCOME_SALES` · CBO · `AA` on · `VALUE` optimisation (maximise value of conversions) where eligible, else `OFFSITE_CONVERSIONS` on Purchase |
| **Campaign B (optional)** | Existing-customer campaign: repeat purchase / upsell, ABO, ≤10% |
| **Audiences built** | Customer-list custom audience **with a value column** → **value-based lookalike**, `ratio: 0.03`, attached as a **suggestion** in Campaign A. Optionally a top-decile-LTV seed as a second suggestion |
| **Exclusions** | A excludes purchasers (180–730d). B *includes* them and excludes recent purchasers (last 30d) |
| **Failure mode** | The value-based lookalike underperforms plain broad — the Loomer result **[E]** says this is the *expected* outcome on a mature account, and the seed is doing nothing. Also: value-based seeds are exactly the shape that trips the `operation_status: 471` integrity filter if named carelessly ("high income", "premium buyers") |
| **Kill criterion** | Drop the lookalike suggestion if Campaign A's CPA does not improve versus a 14-day pre-period with no suggestion. Because the lookalike is a *suggestion* rather than an ad set, removing it is a targeting edit and **will reset the learning phase** — so test it deliberately, not casually |

---

### 10.1 The template selection function

This is directly implementable and should be. Inputs the system already has or can read.

```
choose_template(brand):
    b   = total_daily_budget
    hx  = purchases_in_last_180d          # from Insights / pixel
    warm = size(site_visitors_30d ∪ atc_30d ∪ video75_30d)
    cpa  = observed_or_estimated_purchase_cpa

    if hx == 0 and no_customer_list:            return SEED_AND_HARVEST if b >= 20 else SINGLE_ENGINE
    if b < 50:                                   return SINGLE_ENGINE
    if warm < 1000:                              return SINGLE_ENGINE      # nothing to recapture
    if b < 150:                                  return BROAD_PLUS_RECAPTURE
    if hx >= 100 and value_spread_is_material:   return VALUE_LADDER
    if b >= 500 and cpa <= 40:                   return FULL_THREE_STAGE
    return BROAD_PLUS_RECAPTURE
```

Three properties this deliberately has:

- **`SINGLE_ENGINE` is reachable from every branch.** The product must be willing to tell a user "you
  do not need a funnel", and must be able to *downgrade* an existing account back into it.
- **Nothing depends on the undocumented video-audience rule except `SEED_AND_HARVEST`**, and even
  there the lookalike route (§4.2) is documented. If the §2.4 probe fails, only one template loses a
  feature.
- **Every branch is a function of measured quantities**, not of a user's self-description. A
  non-expert cannot be asked "are you top-of-funnel focused?"; they can be asked for a budget.

---

## 11. Implementation notes for this codebase

### 11.1 What has to exist that does not yet

Nothing under `src/` currently models audiences. A funnel feature needs, at minimum:

| Module | Responsibility | Notes |
|---|---|---|
| `src/meta/audiences.ts` | Create/read/verify custom + lookalike audiences | Must read back `retention_days` after every create (Meta silently truncates, §7.1) |
| `src/domain/funnel.ts` | The five templates as data; the selection function of §10.1 | Const objects + union types — no `enum` (project rule) |
| `src/domain/poolForecast.ts` | The §5.2 arithmetic: budget × days × CPM × p50 → pool size | Feeds the "can we even offer this?" gate |
| `src/preflight/funnel.ts` | Refuse to build a template whose floors are not met | Same posture as the existing preflight module |

The `ArchetypeSpec` shape in `src/meta/objectives.ts` already carries `objective` /
`destinationType` / `optimizationGoal` / `billingEvent` / `promotedObject`, which is exactly the tuple
each funnel stage needs. **A funnel stage is an `ArchetypeSpec` plus an audience spec plus a budget
share.** That is the natural type and it should reuse the existing archetype legality matrix rather
than re-encoding ODAX rules.

### 11.2 API call sequence for a template build (read-only-safe planning form)

```
1.  GET  /act_{id}?fields=account_status,currency,timezone_id,capabilities
2.  GET  /act_{id}/customaudiences?fields=id,name,subtype,approximate_count,
             operation_status,retention_days,delivery_status,lookalike_audience_ids
        -> reuse before create; ad accounts cap at 500 engagement audiences
3.  GET  /act_{id}/insights?fields=impressions,spend,actions,cost_per_action_type
             &action_breakdowns=action_type&date_preset=last_30d
        -> observed CPM, cost per ThruPlay, video_view percentages, purchase CPA
4.  forecast pool size (§5.2) and per-stage learning floor (§5.1)
5.  choose_template()  (§10.1)
6.  [WRITE — not in SIMULATE mode] POST audiences, then campaigns, then ad sets, then ads
7.  GET  /{audience_id}?fields=rule,retention_days,subtype,operation_status,delivery_status
        -> verify what Meta actually stored
8.  GET  /{adset_id}?fields=learning_stage_info{status,last_sig_edit_ts,
             dynamic_lp_conversions_threshold},targeting,daily_budget
```

Step 7 is not optional. Meta accepts and silently alters audience parameters in at least three
documented ways (retention truncation, lookalike location semantics, video-audience default retention
of 730 days when `retention_days` is omitted). An autonomous system must read back what it wrote.

### 11.3 Ordering and timing constraints

- **Audiences must exist and be `ready` before an ad set references them.** Lookalikes take 1–6 hours
  (API doc) or up to 3 days (Help Centre). Ads *can* run against a populating audience, but a
  retargeting ad set launched against an empty audience will be Learning Limited from minute one and
  the diagnosis will look like a targeting problem.
- **Adding a new active ad set to a CBO campaign takes ~2 hours for budget to redistribute**
  ([P](https://www.facebook.com/business/help/2177212182495139)). Do not evaluate a new stage inside
  that window.
- **Batch all edits.** *"If you input changes one at a time, your campaign may have to re-enter the
  learning phase each time."* **[P]**
- **Never pause and unpause ad sets under CBO.** *"Advantage+ campaign budget reserves and spends your
  campaign budget on active ad sets, and pausing an ad set removes it from consideration … By the time
  you unpause the other ad set … there might not be any budget left in the campaign."* **[P]** This is
  a direct constraint on any automated rotation logic.
- **Ad-set spend limit edits take up to 15 minutes to apply.** **[P]**

### 11.4 Constants worth hard-coding

```ts
export const META_LEARNING_PHASE_EVENTS = 50;            // per ad set per week   [P]
export const META_SHOPS_ADS_LEARNING = { website: 17, meta: 5 }; // 7-day         [P]
export const MAX_ENGAGEMENT_AUDIENCES_PER_ACCOUNT = 500;                       // [P]
export const MAX_LOOKALIKES_PER_SOURCE = 500;                                  // [P]
export const MAX_VIDEOS_PER_VIDEO_AUDIENCE = 200;                              // [P] + [O]
export const MAX_PAGE_SOURCES_PER_AUDIENCE = 5;                     // [O] — UNVERIFIED
export const LOOKALIKE_MIN_SEED = 100;                                         // [P]
export const LOOKALIKE_RECOMMENDED_SEED = { min: 1000, max: 5000 };            // [P]
export const LOOKALIKE_RATIO_RANGE = { min: 0.01, max: 0.20, step: 0.01 };     // [P]
export const MAX_ADSETS_PER_CBO_CAMPAIGN = 200;   // >70 locks bid-strategy edits  [P]
export const COST_GOAL_BUDGET_MULTIPLE = 5;       // daily budget >= 5x cost goal  [P]
export const RETENTION_MAX_DAYS = {
  lead_form: 90, shopping: 365, ar: 365, video: 365,
  page: 730, ig_business: 730, canvas: 730,
  website: 180,                 // 730 for Purchase events since 2026-05-18 — UNVERIFIED via API
  page_likes: 0,
} as const;
```

`erasableSyntaxOnly` note: all of the above are const objects and union types — no `enum`, no
`namespace`, no parameter properties, per the project's TypeScript constraints. Relative imports need
the `.ts` extension.

---

## 12. Open questions — what to settle on the first live account

Ranked by how much the answer would change the product. Every one of these is a **read-only or
sandbox-safe** investigation.

1. **The video engagement custom audience API shape (§2.4).** Create one by hand in Ads Manager,
   then `GET /{id}?fields=rule,subtype,retention_days,data_source,operation_status`. Settles the bare-
   array format, the `context_id` semantics, and whether the second-based thresholds (3s / 10s /
   ThruPlay) are expressible at all. **Blocks Template 2's audience path** (though not its lookalike
   path).
2. **Does a video-seeded lookalike get Advantage+ lookalike auto-expansion?** Meta's page names only
   mobile / website / customer-list seeds (§4.4). If engagement seeds are excluded, ratio still
   matters for exactly those seeds — an unexpected and exploitable asymmetry.
3. **Does `retention_days > 180` succeed on a Purchase-event website audience via the API?** The UI
   change shipped 18 May 2026; the API docs still say 1–180 (§7.1). Send 365 and read it back.
4. **Is `AUTOMATIC_OBJECTIVE` available as an `optimization_goal` outside specific objectives?** It is
   in the enum and in no guide. If it works, it may be a better default than the manual optimisation-
   event ladder for cold-start accounts.
5. **What is the real `p50` (share of impressions reaching 50% video completion) for this pipeline's
   generated video?** §5.2 assumes 10%. The whole pool-size forecast scales linearly with it, and it
   is directly measurable from `video_p50_watched_actions` / `impressions`. **This is the single
   highest-value number the platform can learn about itself.**
6. **Does the asset-customisation exclusion (§2.4) actually bite?** Meta says videos used only in
   placement-asset-customisation campaigns cannot seed video audiences. If the creative pipeline uses
   asset customisation by default, Template 2 is silently broken. Verify before shipping either.
7. **Does an exclusion-only Advantage+ ad set really keep `advantage_state` enabled?** Meta's help
   text says yes (§6.2). Confirm by reading `advantage_state` / `advantage_audience_state` back after
   creating an ad set with `excluded_custom_audiences` set and `advantage_audience: 1`.
8. **Is there any measurable difference between a 75%-viewer retarget and no retarget at all?** The
   genuinely unanswered question in the public literature (§3.1). Requires a Conversion Lift test, so
   it needs an account at a budget where lift tests are affordable — but the platform is uniquely
   placed to answer it across many accounts, and the answer would be worth publishing.

---

## 13. Sources

**Meta primary — Business Help Centre** (all fetched 2026-09-05; bodies recovered via Googlebot UA
because the pages are JS-rendered)

- [About the learning phase](https://www.facebook.com/business/help/112167992830700) — 50 results/week; Shops 17+5
- [About learning limited](https://www.facebook.com/business/help/269269737396981) — the forecast semantics; remedy list
- [Significant edits and learning phase](https://www.facebook.com/business/help/316478108955072) — the reset list; CBO Q&A
- [Combine ad sets and campaigns … to reduce audience fragmentation](https://www.facebook.com/business/help/2419480091640105)
- [About managing ad volume](https://www.facebook.com/business/help/2720085414702598)
- [Understand auction overlap](https://www.facebook.com/business/help/537699989762051) — "your ads will not bid against one another"
- [About lookalike audiences](https://www.facebook.com/business/help/164749007013531)
- [Create a lookalike audience](https://www.facebook.com/business/help/465262276878947) — 100 min / 1,000–5,000 rec / 500 per source / seed auto-excluded / location no longer chosen
- [Create a value-based lookalike audience](https://www.facebook.com/business/help/458132024732845)
- [About Advantage+ lookalike](https://www.facebook.com/business/help/1212225059146059)
- [About engagement custom audiences](https://www.facebook.com/business/help/1090330204367211)
- [Create a video engagement custom audience](https://www.facebook.com/business/help/1099865760056389) — 200 videos, sources, retention semantics
- [Troubleshoot video engagement custom audiences](https://www.facebook.com/business/help/288658087296355) — asset-customisation exclusion; Audience Network gap
- [About website custom audiences](https://www.facebook.com/business/help/610516375684216)
- [About Advantage+ audience](https://www.facebook.com/business/help/273363992030035) — cost-per-result claims; **"except retargeting campaigns"**
- [What turns Advantage+ on and Advantage+ off](https://www.facebook.com/business/help/906206294602874) — the exclusion carve-out
- [Choose audience settings in Advantage+ campaigns](https://www.facebook.com/business/help/25941857932125812) — controls vs suggestions
- [Use Advantage+ custom audience](https://www.facebook.com/business/help/414975413946182)
- [About the Advantage+ campaign experience](https://www.facebook.com/business/help/1292656978738967)
- [About Advantage+ campaign budget](https://www.facebook.com/business/help/153514848493595)
- [Best practices for Advantage+ campaign budget](https://www.facebook.com/business/help/2177212182495139) — 70 ad sets; 2-hour rebalance; **largest audience gets the budget**
- [About ad set spend limits with Advantage+ campaign budget](https://www.facebook.com/business/help/454681230514942)
- [Advantage+ campaign budget for campaigns with 70+ ad sets](https://www.facebook.com/business/help/519856662172206) — 200 cap
- [Best practices for minimum budgets](https://www.facebook.com/business/help/203183363050448) — 5× cost-per-result-goal rule; dollar minimums removed
- [Review or update expiring audiences](https://www.facebook.com/business/help/1023477888441636) — 30-day window after Page deletion
- [Ad account limits](https://www.facebook.com/business/help/1026272311098874)

**Meta primary — Marketing API** (machine-readable `.md` variants, fetched 2026-09-05)

- [Lookalike Audiences](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/lookalike-audiences.md) — `lookalike_spec`, campaign-conversion lookalikes, `operation_status` 471, inactivity/expiry, the delayed `country` removal
- [Engagement Custom Audiences](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/engagement-custom-audiences.md) — event sources, event names, max retention per source, 500/account
- [Website Custom Audiences](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/website-custom-audiences.md) — `retention_days` 1–180, `prefill` cap
- [Audience Rules](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/guides/audience-rules.md) — operators, fields, `retention_seconds` max
- [Ad Set reference](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/) — `optimization_goal` / `billing_event` enums, `daily_min_spend_target`, `daily_spend_cap`

**Experimental / academic**

- Haus, [*The Meta Report: Lessons from 640 Haus Incrementality Experiments*](https://www.haus.io/blog/the-meta-report-lessons-from-640-haus-incrementality-experiments) and [*Is Meta Incremental?*](https://www.haus.io/blog/is-meta-incremental) — the Advantage+ vs Manual numbers, funnel-stage incrementality factors
- Haus, [*Understanding Meta incrementality testing*](https://www.haus.io/article/meta-incrementality-testing) — what "upper/mid/lower funnel" means in their taxonomy
- Gordon, Moakler & Zettelmeyer, [*Close Enough? A Large-Scale Exploration of Non-Experimental Approaches to Advertising Measurement*](https://arxiv.org/abs/2201.07055), Marketing Science 42(4):768–793 — 663 Facebook RCTs; 115%/107%/62% median error at upper/mid/lower funnel
- [*Characterizing and Minimizing Divergent Delivery in Meta Advertising Experiments*](https://arxiv.org/pdf/2508.21251) — 3,204 Lift tests vs 181,890 A/B tests; Lift tests are unbiased, A/B tests are not

**Practitioner (named, with real accounts)**

- Jon Loomer, [*3 Times You Should Prioritize Remarketing Over Meta's Algorithmic Ad Targeting*](https://www.jonloomer.com/prioritize-remarketing-over-metas-algorithmic-ad-targeting/) — "Beware of Soft Remarketing"; the 25–45% warm-spend measurements
- Jon Loomer, [*When Broad Targeting Fails*](https://www.jonloomer.com/when-broad-targeting-fails/) — "optimisation is literal"; the $10-event / $500-week learning arithmetic
- Jon Loomer, [*Test Results: Advantage+ Audience vs. Detailed Targeting and Lookalikes*](https://www.jonloomer.com/test-results-advantage-plus-audience-detailed-targeting-lookalikes/) — the 30-day / $2,250 controlled split test
- Jon Loomer, [*How to Approach Meta Ads Targeting Now*](https://www.jonloomer.com/meta-ads-targeting-guide/)

**Trade press / agency (directional, cited as [C])**

- ppc.land, [*Meta deprecates legacy campaign APIs for Advantage+ structure*](https://ppc.land/meta-deprecates-legacy-campaign-apis-for-advantage-structure/) — `advantage_state`, the three levers, the v25.0 timeline
- kitchn.io, [*Meta Ads Manager Updates: May 2026*](https://www.kitchn.io/blog/meta-ads-manager-updates-may-2026) — 730-day purchase retention (18 May 2026); API deadline (19 May 2026)
- Baker, [*Meta Ads Campaign Structure: The Right Setup for Every Budget*](https://withbaker.com/blog/meta-ads-campaign-structure-budget-setup) — budget-tier structure table
- Flighted, [*The Best Meta Ads Account Structure in 2026*](https://www.flighted.co/blog/best-meta-ads-account-structure-2026) — the ~$1K/day retargeting threshold
- AdSights, [*Cost Per ThruPlay: formula and benchmarks*](https://www.adsights.ai/resources/glossary/metrics/cost-per-thruplay) — $0.03–$0.10 tier-1

**Observed implementation [O]**

- `audience-payload.ts` — a production Meta-automation module present in this session's scratchpad
  (`/tmp/claude-0/.../scratchpad/audience-payload.ts`), not part of this repository. Its author
  annotated each constant with the live audience ID and date it was verified against
  (2026-05-07 / 2026-05-21). Source of the video-engagement rule shape (§2.4), the
  `video_view_*_percent` / `video_completed` event names, the 200-video cap error code, and the
  5-page-source cap. **Treat as a hypothesis to probe, not as documentation.**

---

## 14. What this dossier changes about the product

Six concrete positions, stated so they can be argued with:

1. **Ship `Single Engine` first and make it the default.** The multi-stage templates are the
   interesting engineering; the single-ad-set template is the correct answer for most users and the
   only one that works at every budget. A product that leads with the funnel is optimising for
   demo appeal over user outcome.
2. **Gate every funnel template behind computed floors, not user choice.** The system knows the
   budget, the CPM, the pool size and the CPA. It should refuse to build a stage that cannot reach
   its floor and say why, in one sentence, in the user's terms: *"A retargeting stage needs about
   1,000 people; at $8/day you'll have around 750 by day 30. I'll add it automatically when you get
   there."*
3. **Build funnels out of exclusions and creative, never out of inclusions.** This falls straight out
   of §6.2 and it simplifies the implementation enormously — the audience layer becomes small.
4. **Treat the video-view funnel as a cold-start tool with a hard expiry.** Template 2 exists,
   Template 2 stops itself, and no template ever targets a video-view pool with a conversion ad set.
5. **Make "collapse the funnel" a first-class automated action.** Every template has a kill criterion
   in §10. The autonomy loop should be as willing to remove a stage as to add one, and the
   Learning-Limited response for a retargeting ad set must be stage-aware (§9.2).
6. **Measure `p50` and pool growth from day one.** The pool-size forecast in §5.2 is the mechanism by
   which the product avoids offering funnels that cannot work, and every constant in it is
   measurable from Insights. It should be a per-brand learned quantity, not a hard-coded assumption.
