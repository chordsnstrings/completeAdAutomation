# Performance Creative Playbook — encoding DR creative craft as machine-executable rules

**Scope:** what actually makes a Meta (Facebook/Instagram) direct-response ad convert, expressed as taxonomies, thresholds, templates and decision rules that an autonomous system can execute without a human.
**Compiled:** 2026-09-02. **Companion docs:** `meta-video-creative.md` (upload/creative API, placement specs, char limits), `meta-insights-measurement.md` (metric field names, retention caps, breakdowns), `meta-optimization-controls.md`, `meta-policy-compliance.md` (AI disclosure, FTC testimonial rule). This document deliberately does **not** re-derive those; it cites them.

---

## 0. Method, source hierarchy, and an honest limitation

### 0.1 Confidence key used throughout

| Tag | Meaning |
|---|---|
| **[DATASET]** | Comes from a published, methodologically-documented aggregate dataset with stated definitions and suppression rules. Highest confidence available for creative claims. |
| **[VENDOR-CANON]** | A vendor's own published, versioned, canonical taxonomy or framework, explicitly written to be cited. Reliable as *a* taxonomy; not proof of causality. |
| **[PRACTITIONER]** | Named operator with attributed quotes / stated spend levels. Directional. |
| **[FOLKLORE]** | Widely repeated, no primary source located. Flagged, not relied on. |
| **[UNVERIFIED]** | Could not confirm this session. Explicitly stated rather than guessed. |

### 0.2 The load-bearing source

The single most valuable source found is **Motion's *Creative Benchmarks 2026*** — and critically, Motion publishes an **LLM-targeted data package** alongside the marketing page:

- Report page: <https://motionapp.com/thumbstop-pulse/creative-benchmarks-2026>
- **Machine-readable package (download this, don't scrape the page):** <https://runt-media.motionapp.com/files/2026-motion-creative-benchmarks-report-llm.zip>
  Contains `LLM_REPORT.md`, `LLM_DATA_APPENDIX.md`, `SOURCE_MAP.md` (per-chart provenance + suppression rules), `CHART_SPECS.json` (typed chart schema).
- Per-finding permalink pages: <https://motionapp.com/library/research/creative-benchmarks-2026/>

**Provenance note worth knowing:** the report's own hero image asset is named `meta_motion_creative_benchmarks_2026_7119c553b1.jpg` (served from `runt-media.motionapp.com/strapi/`), i.e. the report is co-branded with Meta. That does **not** make it a Meta publication, and the methodology is Motion's own tagging dataset, not Meta's ad system. Treat it as the best available third-party census, not as first-party Meta truth.

Stated methodology, verbatim-equivalent (from `LLM_REPORT.md` front-matter):

```yaml
data_window:  {start: "2025-09-01", end: "2026-01-01"}
dataset:      {creatives: 578750, advertiser_accounts: 6015, realized_spend_usd: 1290000000}
definitions:
  winner:    {spend_multiple_of_account_median: 10, spend_floor_usd: 500}
  mid_range: {min_days_with_spend: 28, not_winner: true}
  loser:     {turned_off_before_day: 28}
privacy:
  dataset_name: "metrics_tagged_creatives_20260130"
```

Suppression constants (from `SOURCE_MAP.md#SUPPRESSION_RULES`, described as "from the notebook — **do not invent new thresholds**"):

```
MIN_ACCOUNT_CREATIVES            = 10    # drop accounts with <10 creatives in window
MIN_ACCOUNTS_FOR_BRAND_CATEGORY  = 50    # vertical with <50 accounts → remapped to "Other"
MIN_ACCOUNTS_FOR_FORMAT          = 50    # format/hook/asset segment needs >=50 accounts to publish
MIN_ACCOUNTS_FOR_TAXONOMY        = 100   # diversity-score computation only
TIER_THRESHOLDS                  = 10    # winner ratio-to-median, same for all tiers
MIN_SPEND_FLOOR                  = 500   # USD
```

The report explicitly bounds its own claims — quote it back to stakeholders when someone over-reads it:

> "Findings are **associations** … not proof that changing spend *causes* a change in hit rate. Do not claim that 'testing more creatives per week causes more winners' in a causal sense."
> "**Cannot:** Infer ROAS, revenue, or conversion impact; attribute success to a single format or hook in a causal way."
> "**Spend as primary success metric:** Performance is evaluated using realized spend, not CTR, CPA, or ROAS."

**That last line is the most important caveat in this whole document.** Every format/hook/asset leaderboard below ranks by *how much budget Meta's delivery system chose to give the ad*, not by profit. A format can top the leaderboard because it is good at earning algorithmic spend, which is a *proxy* for advertiser satisfaction, not a measure of it.

### 0.3 Limitation of this research session (disclose, don't hide)

General web search was unavailable for this session (WebSearch budget exhausted; DuckDuckGo/Brave/Ecosia/SearxNG blocked or rate-limited at the egress proxy; Bing and Google served bot-degraded or JS-only result pages to `curl`). Research was therefore conducted by **direct sitemap and `llms.txt` harvesting of primary vendor domains**, which is higher-quality for the sources reached but means **coverage is narrower than a search-driven sweep**. Specifically under-covered, and flagged again in §16: peer-reviewed attention research, Meta's own Business Help Center creative guidance (see next paragraph), and quantitative AI-UGC A/B evidence.

**Meta's advertiser-facing creative guidance is not machine-readable.** `facebook.com/business/help/*`, `facebook.com/business/ads-guide/*` and `transparency.meta.com/*` are client-rendered React; `curl` receives HTTP 400 with a body of `Error`, and `WebFetch` returns only the `<title>`. This is the same finding recorded in `meta-video-creative.md` §9. Consequence for the build: **you cannot programmatically ingest Meta's creative-spec pages as a source of truth.** Character limits, safe zones and CTA enums must be pinned from the already-extracted tables in `meta-video-creative.md` §9–§10 and re-verified by a human on a cadence.

---

## 1. The governing fact: Meta creative performance is a power law, not a normal distribution

Everything downstream — how many ads to make, when to kill, what "good" means, how to allocate compute — falls out of this. **[DATASET]**

### 1.1 The distribution

| Fact | Value | Source |
|---|---|---|
| Share of creatives that reach >=10x account-median spend (a "winner") | **~5%** overall; the 10x threshold sits at the **92.3rd percentile** of the ratio-to-median distribution, i.e. **~7.7%** above it | `LLM_REPORT.md` KF-001, KF-005 |
| Share of *spend* going to winners / mid-range / losers | **55% / 28% / 17%** | KF-004 |
| Share of *creatives* that are losers (killed before day 28) | **~50–53%** across every tier | CH-005 |
| Ads responsible for the majority of spend in a given account | **~6%** | Part 1 narrative |

**Portfolio composition by spend tier (CH-005, % of creatives):**

| Spend tier (monthly) | Loser % | Mid-range % | Winner % |
|---|---|---|---|
| Micro (<$10K) | 50.2 | 46.0 | 3.7 |
| Small ($10K–$50K) | 49.3 | 44.6 | 6.2 |
| Medium ($50K–$200K) | 52.6 | 40.1 | 7.3 |
| Large ($200K–$1M) | 53.9 | 38.0 | 8.1 |
| Enterprise ($1M+) | 52.2 | 39.6 | 8.2 |

**Spend allocation by tier (CH-006, % of spend):**

| Spend tier | Loser % | Mid-range % | Winner % |
|---|---|---|---|
| Micro | 31.5 | 45.6 | 23.0 |
| Small | 25.7 | 39.7 | 34.6 |
| Medium | 18.6 | 28.1 | 53.3 |
| Large | 17.1 | 26.4 | **56.5** |
| Enterprise | 13.8 | 22.4 | 63.7 |

> **Data-integrity flag, carried from the source:** the Large-tier row is *reconstructed*. `SOURCE_MAP.md` Open Question #1 states the PDF p.9 OCR gave `26.4 / 56.5 / 17.1` and the publisher re-ordered it to make winner-share monotone in tier. If your system uses these numbers as priors, treat the Large row as **[UNVERIFIED]**.

### 1.2 Testing volume and hit rate by tier (CH-003 / CH-008)

| Spend tier | Avg creatives/week (all) | Avg creatives/week (top 25% of accounts) | Winners/month (all) | Winners/month (top 25%) | Avg hit rate % |
|---|---|---|---|---|---|
| Micro (<$10K) | 2.8 | 4.8 | 0.0 | 0.0 | 4.0 |
| Small ($10K–$50K) | 4.1 | 8.0 | 0.2 | 0.5 | 6.4 |
| Medium ($50K–$200K) | 6.6 | 15.9 | 0.7 | 2.0 | 8.1 |
| Large ($200K–$1M) | 11.2 | 31.1 | 1.7 | 5.9 | 8.6 |
| Enterprise ($1M+) | 18.8 | 54.6 | 3.9 | 10.4 | 8.8 |

Medians differ from means and are published separately (`LLM_DATA_APPENDIX.md`, "Methodology summary", PDF p.24 — *median, mean, avg hit rate*): Micro 2.3 / 3.4 / 4.0; Small 4 / 5.6 / 6.5; Medium 6.9 / 9 / 8.1; Large 11.1 / 16.8 / 8.6; Enterprise 18.2 / 29.8 / 8.8. **Use medians as the planning target; the mean is inflated by the top quartile.**

"Top 25%" is defined as `winnerPercentileInTier >= 0.75` — top quartile *by winner count* within tier.

### 1.3 What this forces in the architecture

1. **A "winner" must be defined as an account-relative outlier, not an absolute threshold.** Encode `is_winner = (creative_spend / account_median_creative_spend >= 10) AND (creative_spend >= 500)`. An absolute CPA/ROAS gate will mis-classify across tiers.
2. **The system's primary output metric is `winners_per_month`, not average creative quality.** The report is explicit: volume "does not make the average ad better; it increases how often an advertiser runs into something exceptional."
3. **Hit rate must never be a top-line KPI.** The report devotes a whole chart (CH-004) to why: hypothetical Account A (50 launches, 5 winners, 10% hit rate) vs Account B (5 launches, 1 winner, 20%). B looks better and is worse. If your system optimises hit rate it will learn to *stop testing*. Encode hit rate as a **diagnostic with volume as a mandatory co-reported denominator**.
4. **Budget the "loser" tranche as expected cost, not as failure.** At micro spend, ~31.5% of spend is definitionally going to ads killed before day 28. That is the *price of the option*, and a P&L model that treats it as waste will strangle the testing loop.
5. **Protect mid-range ads.** 38–46% of creatives and 22–46% of spend are mid-range (>=28 days, never a winner). The report calls them "ballast": they "keep performance steady while new ideas compete for spend." A naive auto-kill rule ("pause anything not hitting target ROAS") will delete the account's stability layer.
6. **Set volume targets from the tier x vertical cell, not a global constant** (see §13.1).

---

## 2. The creative stack — the ontology to encode

Motion publishes an explicit four-layer stack, and it is the cleanest available formalisation of "what to vary and in what order." **[VENDOR-CANON]**

> "Messaging Angle → Creative Mechanic → Hook → Visual Format. Format and mechanic are bidirectional — you can start with a format and work backward to find the right mechanic, or start with a mechanic and find the format that best delivers it."
> — <https://motionapp.com/library/formats/> (FAQ: "Where does format sit in the creative stack?")

Expanded with the strategic layer above it (<https://motionapp.com/library/frameworks/creative-strategy-engine>):

```
Pain / Desire            (primary anchor — what the product actually does)
  └─ Persona             (secondary — the life context in which the pain is felt)
      └─ Messaging Angle (the core truth at that pain x persona intersection)
          └─ Awareness Stage   (5 stages; determines the strategy, not the truth)
              └─ Creative Mechanic  (how the viewer arrives at the truth)
                  └─ Hook Tactic     (the strategic frame of the first 1–3s)
                      └─ Psych Trigger (the emotional mechanism inside the frame)
                          └─ Visual Format (the production vessel)
                              └─ Asset Type (the medium / production tier)
```

**Why this matters for automation more than for humans:** an LLM asked for "10 ad ideas" will produce 10 *format* variations of one angle and call it a test. The stack lets you enforce diversity at the level that actually matters. Encode a `concept_id` at the **Messaging Angle** level and a `variant_id` below it, and make your diversity constraint operate on `(angle, mechanic, hook_tactic)` — not on the rendered file.

Motion's own glossary makes the distinction and — importantly — flags that Meta's 2026 ranking changes devalued the lower layers:

> "A **concept** is the big structural idea… A **variant** (also called an iteration) is a small change within that concept; different hook, different color palette, different opening clip. Historically, best practice has been to test concepts and then iterate on winners. **Meta's Andromeda algorithm has made iterations less effective**, but there is still some value in them."
> — <https://motionapp.com/library/glossary/creative-concept-vs-variant>

See §11.3 for what Andromeda is and how contested it is.

---

## 3. Hook mechanics, the retention curve, and why thumb-stop is the leading indicator

### 3.1 The metric definitions — and a real contradiction you must resolve before coding

| Metric | Formula | Source |
|---|---|---|
| **Thumbstop rate / hook rate** (same metric) | `(3-second video plays / impressions) x 100` | <https://motionapp.com/library/glossary/thumbstop-rate-hook-rate>; also <https://motionapp.com/thumbstop-guide/how-to-stop-a-scroll-in-3-seconds> |
| **Hold rate — version A** | `(15-second video plays / 3-second video plays) x 100` | <https://motionapp.com/blog/key-creative-performance-metrics> |
| **Hold rate — version B** | `(ThruPlays / 3-second video plays) x 100` | <https://motionapp.com/library/glossary/hold-rate> |
| **CTR** | `clicks / impressions x 100` | same |

> **Gotcha (costs a day):** the same vendor publishes **two different hold-rate definitions** on two pages. They are not interchangeable — ThruPlay is *15 s, or completion if the video is shorter than 15 s*, so for a 12-second ad version B counts completions while version A counts an event that can never fire. **Pick version B (ThruPlay-based) and store the definition alongside the value.** Version A silently reports 0% hold rate for every ad under 15 s, which is most Reels creative.

**Mapping to actual Insights API fields** (see `meta-insights-measurement.md` §3 for the full field table and retention caps):

| Concept | Field | Notes |
|---|---|---|
| 3-second video plays | `video_play_actions` | This is the field practitioners mean by "3-second plays." Verify the action-type breakdown against a live account before trusting it as a clean 3 s count — **[UNVERIFIED]** whether it is strictly 3 s in v26.0. |
| ThruPlays | `video_thruplay_watched_actions` | `meta-insights-measurement.md` §16 flags that this field is present in the v26.0 Python SDK's `AdsInsights.Field` but could not be found in the doc field table — confirm against a live account. |
| Retention curve | `video_p25_watched_actions`, `p50`, `p75`, `p95`, `p100` | The actual decay curve; far more useful than a single hold number. |
| Avg watch time | `video_avg_time_watched_actions` | |
| 2-second continuous | `video_continuous_2_sec_watched_actions` | |
| Impressions | `impressions` | |

**Build note:** compute the retention curve as the vector `[3s_rate, p25, p50, p75, p95, p100]` normalised to impressions, and store it per creative. Regressing on the *shape* of that curve (where the cliff is) is far more diagnostic than any single scalar, and it is what lets you attribute a failure to the hook (cliff at 3 s) versus the hook→body transition (cliff between 3 s and p25) versus a weak offer (healthy curve, dead CTR).

### 3.2 Published benchmarks — with their disagreements shown

| Metric | Benchmark | Source / caveat |
|---|---|---|
| Hook rate — "strong performance" | **30–40%** target; **flag below 25%** ("if 3-second view rate drops below 25%, it's a creative problem, not a media buying problem") | <https://motionapp.com/blog/key-creative-performance-metrics> **[PRACTITIONER]** |
| Hook rate — "generally solid" | **20–40%** | <https://motionapp.com/library/glossary/thumbstop-rate-hook-rate> **[VENDOR-CANON]** — note this is a *wider* band than the blog's |
| Hook rate — "captures interest quickly" | **above 35%** | same blog |
| Hold rate | average **40–50%**; **>60% strong** | same blog |
| CTR — all industries | **0.9–1.5%** | same blog |
| CTR — ecommerce | **1.5–2.5%** (fashion 2.64%, electronics 1.91%) | same blog |
| Meta "strong creative" composite | 30–40% hook, 25%+ hold, 1.5%+ CTR for ecom | same blog |
| ROAS — Meta average | **2.5–4.0**, explicitly disclaimed as a bad benchmark because required ROAS is an LTV function | same blog |

**Legacy industry CTR table** — appears on Foreplay (<https://www.foreplay.co/post/average-click-through-rate-for-facebook-ads>): all-industry **0.90%**, legal 1.61%, retail 1.59%, apparel 1.24%, technology 1.04%, employment/job training 0.47%. These figures match the long-circulating WordStream benchmark set; **no publication date or sample was given on the page. Treat as [FOLKLORE] with a plausible origin.** Do not seed a model with them.

**Why the disagreement is fine and what to do about it.** The most defensible position on the same vendor's own guide page is that absolute benchmarks are not the point:

> "It is important to note that a winning thumbstop ratio will vary brand-to-brand and industry-to-industry, so you are best off avoiding 'optimal' numbers that gurus will share. Instead, the winning mentality is to establish your own baseline and grow based upon that."
> — <https://motionapp.com/thumbstop-guide/how-to-stop-a-scroll-in-3-seconds>

**Encode this as an account-relative z-score, with the published bands used only as a cold-start prior for the first ~30 creatives**, then decay the prior to zero once you have an account baseline.

### 3.3 Why thumb-stop is the *leading* indicator (the causal chain to encode)

The argument, as stated across the Motion sources, is a three-stage funnel with a strict precedence order:

1. **Attention** — hook rate. "It doesn't matter how strong the rest of your ad is if nobody watches it."
2. **Engagement** — hold rate, avg watch time, completion.
3. **Action** — CTR, CVR, CPA, ROAS.

Plus a delivery-side feedback loop: *"Meta rewards content that quickly engages by serving it more efficiently, which translates directly to lower CPMs and cheaper cost per action"* and *"the algo rewards creatives that keep users engaged on-platform, so hold metrics significantly impact how efficiently your ads serve."* **[PRACTITIONER]** — this is a plausible mechanism and consistent with auction behaviour, but I found **no Meta primary source** stating it. Mark **[UNVERIFIED]** as a mechanism; use it as a heuristic, not a model assumption.

**The diagnostic decision table — encode this verbatim as the creative-iteration router:**

| Hook rate | Hold rate | CTR | CVR | Diagnosis | Automated next action |
|---|---|---|---|---|---|
| Low | — | — | — | Hook failure | Regenerate first 1–3 s only; keep body, offer, copy. Vary hook tactic + psych trigger. |
| OK | Low | — | — | Hook↔body disconnect | Rewrite the body's first beat to *pay off* the hook's promise. Same hook. |
| OK | OK | Low | — | Weak CTA / value clarity | Vary CTA, offer framing, on-screen end card. Keep hook + body. |
| OK | OK | OK | Low | Ad↔landing-page discontinuity, or wrong audience | Landing-page continuity check (§9.5) before touching creative. |
| High | OK | High | Low | Clickbait failure mode | **Penalise.** See §3.4. |

The blog states the first three explicitly: *"Hook rate low? Fix the first three seconds with stronger pattern interrupts. Hook rate strong but hold rate weak? Improve your story arc and proof points."*

### 3.4 The single-metric trap — a hard constraint, not a guideline

The clickbait failure mode is described concretely and is exactly what a naive RL loop will discover:

> "You optimize purely for CTR. Creative teams start using increasingly clickbait-style hooks that drive CTR to 4.5%. You triple CTR but conversion rates tank because you're attracting curious clickers who have no purchase intent. CPA explodes, ROAS collapses, but hey, CTR looks great in the deck."

**Build requirement:** the creative scoring function must be a **constrained** objective, not a weighted sum. Concretely: maximise `winners_per_month` (or downstream margin) **subject to** hook rate, hold rate and CTR each remaining above account-relative floors. A weighted sum lets the optimiser trade CVR away for CTR; a constraint does not. This is the most likely way an autonomous creative system silently destroys an account.

Corroborating evidence that CTR is a weak proxy for value, cited in the same article: Nielsen research (via Meta) that **"creativity drives 56% of a campaign's ROI"**, versus Martech research that **CTR influences only 4% of ROI**. Both are **[FOLKLORE]** as cited — no primary link was given on the page and the underlying Nielsen Catalina study was not reachable this session. The *direction* (creative >> CTR as a value driver) is consistent across every source found; the specific percentages should not be quoted as fact.

### 3.5 The anatomy of a thumb-stop — three required elements

From <https://motionapp.com/thumbstop-guide/how-to-stop-a-scroll-in-3-seconds> (attributed to Nick Shackelford / Konstant Kreative) **[PRACTITIONER]**. This is directly parameterisable as a generation constraint on frame 0–3 s:

| Element | Function | What it tells the viewer | Generation slot |
|---|---|---|---|
| **1. Human element** | A person visibly expressing an emotion the target audience recognises | *who you care about* | `hook.presenter{demographic, emotion_state}` — cast to resemble the target persona; the emotion must be the one the persona feels facing the pain |
| **2. Bold problem statement** | A short text statement, because "audiences often view the first few seconds of video ads without audio" | *why they should care* | `hook.text_overlay` — must render legibly in the safe zone (see `meta-video-creative.md` §9.1: 14% top / 35% bottom / 6% sides) |
| **3. Shocking or satisfying hook** | A visual payoff that is unexpected or viscerally satisfying | *what emotion to feel* | `hook.visual_beat{type}` — one of three enumerated sub-types below |

The three enumerated sub-types of element 3:
- **Satisfying-in-product** — the product doing something inherently pleasing (knife through moon sand).
- **Satisfying-in-result** — the *outcome* demonstrated dramatically (clean bread wiped on a treated tire).
- **Shocking-in-problem** — the *problem* shown viscerally (close-up of a mosquito biting; a cat shredding a mattress).

**Sound-off is the default assumption.** The bold problem statement exists specifically because audio is off. Any generated hook whose meaning depends on the voiceover in the first 3 seconds is a defect. Encode as a hard pre-flight check: *the first 3 seconds must be comprehensible with audio muted.*

The corresponding QA rule from a 200-ads/week production shop: *"Watch the ad with sound off at least once."* — Savannah Sanchez, <https://motionapp.com/blog/how-to-build-a-high-volume-ad-production-system-for-meta-and-tiktok-in-2026>

### 3.6 The 8 psychological triggers (the emotional mechanism layer)

From <https://motionapp.com/library/frameworks/hook-writing> **[VENDOR-CANON]**. "Every killer hook leverages at least one of these. The best ones combine two."

| # | Trigger | Mechanism | Example given |
|---|---|---|---|
| 1 | **Pattern Interrupt** | Break mental autopilot; unexpected/counterintuitive/visually jarring | "Stop moisturizing your face." |
| 2 | **Identity Call-Out** | Make the right people self-select; hyper-specific identity | "If you're a bride with cystic acne, watch this." |
| 3 | **Pain Agitation** | Mirror the internal monologue back | "You've tried everything and your skin is still breaking out." |
| 4 | **Curiosity Gap** | Open a loop they need to close; start mid-story | "Nobody's talking about this Meta update." |
| 5 | **Social Proof / Credibility** | Real people, real numbers, unpolished specificity | "I've been breaking out since I was 12. Here's what finally worked at 29." |
| 6 | **Contrarian / Myth-Busting** | Challenge a held belief; imply they've been lied to | "Retinol is the reason your skin keeps purging." |
| 7 | **Aspiration / Desire** | Show the post-product self | "You're 6 weeks away from not thinking about your skin anymore." |
| 8 | **Urgency / Stakes** | Make inaction feel costly | "Every day you don't fix this, you're leaving money on the table." |

**Trigger cheat-sheet (direct mapping table, encode as a lookup):** stop autopilot → Pattern Interrupt; make them self-select → Identity Call-Out; make them feel understood → Pain Agitation; build intrigue → Curiosity Gap; build credibility fast → Social Proof; challenge a belief → Contrarian; show what's possible → Aspiration; make inaction costly → Urgency/Stakes.

**Hard generation rules from the same source (encode as validators, not prompt suggestions):**

*DO:* write in the reader's voice not brand voice; use specific numbers/timeframes; mirror the persona's exact language; lead with pain/desire not product; write for ONE person; read aloud — "if it sounds like an ad, rewrite it"; **vary the psychological trigger across the hook set**.

*DON'T:* start with "Introducing…" / "Discover…" / "Are you looking for…"; open with brand or product name; write hooks that could apply to any product; corporate/clinical language; sound like an ad in the first sentence; **repeat the same trigger type across every hook in the set**.

The last DO/DON'T pair is the machine-checkable one and the one an LLM violates by default: **enforce trigger diversity as a set-level constraint on every generated hook batch.**

### 3.7 Required output shape for a video hook

Three parallel channels, generated together — from `hook-writing`:

```
HOOK #n — [Trigger Type]
SPOKEN:       "[first words said on camera]"        # must work with no visuals
VISUAL:       [first frame — action, scene, element] # must work with no audio
TEXT OVERLAY: "[on-screen text]"                     # must work alone
```

> "Spoken hook — First words out of their mouth. **Should work even without visuals.**"

This is a genuinely useful generation contract: each of the three channels must independently carry the hook. It gives you three cheap validators and it is the structure Motion's own ad-breakdown pages use (see §5.1).

---

## 4. The creative genome — tagging every ad so you regress on attributes, not ads

This is the core mechanism for a system that improves itself. Individual ads are unrepeatable; *attributes* are.

### 4.1 Who actually does this, and with what schema

| Vendor | Mechanism | Schema published? |
|---|---|---|
| **Motion** (`motionapp.com`) | "AI Tagging" — automatic per-creative tagging of Meta ads, plus Comparative Reports that **group performance by tag** | Yes — see 4.2. Plus a 113-format / 33-hook / 8-mechanic public canon (§5, §6, §7) |
| **Foreplay** (`foreplay.co`) | "Content Style Filters" (AI categorisation of a large public ad library) + "Lens" creative analytics + a public MCP server | Partially — 9 launch filters, see 4.3 |
| Named competitors in this category (from Foreplay's own comparison nav) | Atria, Superads, Magic Brief, Adnova, Gethookd, AdsLibrary.ai, Adscan, SwipeKit | Not examined this session — **[UNVERIFIED]** |

### 4.2 Motion's AI Tagging schema — the most concrete published genome

Source: <https://help.motionapp.com/en/articles/12461770-getting-started-with-ai-tagging-in-motion> (article dated 2026-04-03). **[VENDOR-CANON]**

Four groups, seven enumerated dimensions:

| Group | Dimension | Example values given |
|---|---|---|
| **Visual** | `asset_type` | UGC, lifestyle image, high production |
| **Visual** | `visual_format` | listicle, founder story, skit, podcast |
| **Persona** | `intended_audience` | moms of tweens, wellness seekers |
| **Messaging** | `messaging_theme` | chronic illness support |
| **Messaging** | `seasonality` | Black Friday / Mother's Day / "Wellness January" / Evergreen |
| **Messaging** | `offer_type` | promo, evergreen, always-on offer |
| **Hook** | `hook_headline_tactic` | question, callout, contrarian |

> **Discrepancy to note:** the article says "These **8** categories are the 80/20 of creative insights" and "**8** ready-to-use comparative reports," but enumerates only **7** tag dimensions across 4 groups, both in the overview list and in the per-category FAQ breakdown. The 8th is not named anywhere on the page. **[UNVERIFIED]** — do not assume you know it.

Stated distinctions between the two visual dimensions (this is the part people get wrong):

> "**Asset type** — this is a broad range of creative formats… Think of this as varying levels of production time or budget needed.
> **Visual format** — this is the style of your creative, a narrower view of the Asset type. For example, a UGC asset can have visual formats like skits, overlays, green screens, or testimonials."

So: `asset_type` = production tier / medium; `visual_format` = structural style. **They are hierarchical, not parallel.** A genome that flattens them loses the ability to ask "does high-production help *within* the testimonial format?"

Operational constraints on the tagging system (directly relevant to your ingest design):
- Only Meta creatives **with spend in the last 90 days**, plus new creatives processed daily.
- A new ad account needs **>=10 creatives launched in the last 90 days** before tagging runs.
- Tags land **24–36 hours** after a data source is connected and synced.
- Tags are displayed in English but applied to creative in ~100 languages (full list on the page).
- Tags are **editable per creative** and the edit propagates to all reports for that creative only.
- Stated design intent, a useful calibration for your own tagger: *"Our system uses full context of your brand, products, and insights from world-class creative strategists to categorize creatives as objectively as possible (similar to how Meta's AI tools would interpret them)."*

The stated analysis pattern is exactly the regression-on-attributes idea:

> "If your top 3 ads all use a question as the hook and chronic illness support as a messaging theme, you've just found a playbook to scale."

### 4.3 Foreplay's Content Style Filters (a second, coarser taxonomy)

Source: <https://www.foreplay.co/post/introducing-content-style-filters> **[VENDOR-CANON]**

V1 filter set (9 values, **images only** at launch):
`Before and After` · `Facts and Stats` · `Features and Benefits` · `Holiday - Seasonal` · `Media and Press` · `Promotion and Discount` · `Reasons Why` · `Testimonial - Review` · `Us vs Them`

> "As of today, content filtering is available across all accounts on Images only — but buckle up, video filters are just around the corner with **stacked categorization**. This will identify the **multiple content types used throughout a video ad**."

**"Stacked categorization" is the important design signal.** A 45-second UGC ad is not one format; it is a *sequence* (Problem Agitation → Demo → Testimonial → Offer). A single-label genome will systematically under-explain video performance. **Design the genome as multi-label with time spans from the start**, e.g.:

```json
{
  "creative_id": "...",
  "asset_type": "UGC",
  "segments": [
    {"t0": 0.0,  "t1": 3.2,  "visual_format": "problem_agitation", "hook_tactic": "confession",  "trigger": "pain_agitation"},
    {"t0": 3.2,  "t1": 18.0, "visual_format": "demo",              "mechanic": "contrast_without_comment"},
    {"t0": 18.0, "t1": 31.0, "visual_format": "testimonial",       "mechanic": "social_witness"},
    {"t0": 31.0, "t1": 38.0, "visual_format": "offer_first_banner","hook_tactic": "urgency"}
  ]
}
```

Motion's format pages already publish **co-occurrence** data at exactly this level — e.g. on <https://motionapp.com/library/formats/problem-agitation>: "Formats often paired with Problem Agitation — Demo **19%**, Educational **11%**, Testimonial **7%**, Expert Explainer **7%**, Screen Recording **7%**, POV **7%**." That is a published transition matrix you can seed a sequence prior with.

### 4.4 The two-dimensional scoring model you should copy

The benchmark report scores every genome value on **two** axes, and insists they are different questions:

- **Hit rate** = *"What percentage of this format's creatives become winners?"* — how often the format produces an outlier.
- **Spend use ratio (SUR)** = `(format's share of total spend) / (format's share of total creative volume)`.
  - `>1.0` → punches above its weight
  - `~1.0` → performs as expected
  - `<1.0` → **overused relative to result**

> "A format may produce many winners but not spend much relative to use; another may rarely produce winners but receive a lot of consistent mid-range spend."

**Encode both.** They give you two different levers:
- **Low hit rate + high SUR** = high-variance bet (Celebrity, Letter). Allocate a small fixed testing slot; don't let the bandit starve it.
- **High hit rate + ~1.0 SUR** = workhorse (Demo, Testimonial). Volume backbone.
- **High hit rate + high SUR** = safest bet (Offer-First Banner, Unboxing). Default.
- **Low hit rate + low SUR** = the thing your genome should learn to stop generating.

SUR is also the correct **exploration-budget signal** for a multi-armed bandit over genome values, because it is already normalised by usage — it answers "given how much I've used this, was it worth it?" rather than "did it win?".

### 4.5 A concrete genome schema to implement

Combining the sources, the minimum viable creative genome for Meta DR:

```jsonc
{
  // ---- strategy layer (varies slowest, matters most) ----
  "pain_or_desire_id":   "bulky_wallet",
  "anchor_type":         "pain",            // pain | desire
  "persona_id":          "minimalist_professional",
  "messaging_angle":     "Your wallet sucks",
  "awareness_stage":     "problem_aware",   // unaware|problem_aware|solution_aware|product_aware|most_aware
  "funnel_stage":        "MOF",             // TOF|MOF|BOF (derived, see §5.3)

  // ---- concept layer ----
  "creative_mechanic":   "contrast_without_comment", // 1 of 8, §7
  "hook_tactic":         "price_anchor",             // 1 of 33, §6
  "psych_trigger":       ["pattern_interrupt","pain_agitation"], // 1-2 of 8, §3.6

  // ---- execution layer ----
  "visual_format":       "us_vs_them",      // 1 of 113, §5.2
  "asset_type":          "ugc",             // 1 of 15, §5.4
  "spokesperson_type":   "customer",        // customer|founder|expert|celebrity|influencer|none|synthetic
  "pov_mix":             {"customer": 1.0, "brand": 0.0},  // see §5.1
  "medium":              "video",           // video|static|carousel|gif
  "duration_s":          31,
  "pacing_cuts_per_10s": 6,
  "caption_style":       "burned_in_word_by_word", // burned_in_* | none | platform_auto
  "aspect_ratios":       ["9:16","1:1","4:5"],
  "dominant_colours":    ["#0f0f10","#e8d8b7"],
  "music_type":          "licensed_library", // none|library|meta_sound_collection|generated|trending
  "emotion_target":      "frustration_to_relief",

  // ---- commercial layer ----
  "offer_type":          "promo",           // promo|evergreen|bundle|gwp|free_trial|guarantee|none
  "offer_value":         "25% off first order",
  "seasonality":         "evergreen",       // evergreen|bfcm|mothers_day|wellness_january|...
  "cta_enum":            "SHOP_NOW",        // must be a valid Meta CTA, see meta-video-creative.md §10
  "landing_page_id":     "lp_slim_wallet_v3",

  // ---- provenance (needed for policy + reproducibility) ----
  "generator":           {"model":"...","version":"...","seed":123,"prompt_hash":"..."},
  "ai_generated":        true,
  "ai_photorealistic_human": false,

  // ---- outcome (joined post-hoc) ----
  "outcome": {
    "spend_usd": 1240.55,
    "ratio_to_account_median": 12.4,
    "class": "winner",             // winner|mid_range|loser  (see §1.1 definitions)
    "days_with_spend": 41,
    "hook_rate": 0.34,
    "hold_rate_thruplay": 0.52,
    "retention_curve": [0.34,0.21,0.14,0.09,0.05,0.04],
    "ctr": 0.019,
    "cvr": 0.031,
    "cpa": 38.10,
    "roas": 2.9,
    "frequency_at_kill": 2.8
  }
}
```

### 4.6 How to actually regress on it — and the three traps

1. **The unit of analysis is the creative, but the unit of *inference* is the attribute value.** Fit something like a hierarchical / mixed-effects model with account as a random effect: `logit(P(winner)) ~ visual_format + hook_tactic + asset_type + awareness_stage + offer_type + (1 | account) + (1 | week)`. The week term is non-negotiable — see trap 3.

2. **Trap 1 — confounding by allocation.** Formats do not get randomly assigned. Offer-First Banner tops the leaderboard partly *because* people run it during promotions with big budgets behind it. Any coefficient you estimate from observational spend data is a **spend-allocation** coefficient, not a causal creative effect. The only way to get a clean estimate is to *randomise the genome value yourself* within a controlled test structure (§12), and your system is uniquely able to do that. **This is the strongest argument for the whole architecture: an autonomous generator can run the randomised experiment a human agency cannot.**

3. **Trap 2 — the >=50-account suppression floor exists for a reason.** The benchmark authors refuse to publish any segment with fewer than 50 accounts. Within a *single* account you will never have 50 accounts, so your per-account genome estimates will be noisy for a long time. Design for **partial pooling**: a global prior fitted across all accounts on your platform, shrunk toward per-account estimates as data accrues. Cold-start every new account from the global (or vertical-level) posterior.

4. **Trap 3 — every leaderboard is time-bound and the source says so repeatedly.** The 2026 window (Sep 2025 – Jan 2026) spans BFCM, and the report warns: *"Promotional hooks are over-represented. Newness, Sale Announcement, Price Anchor all benefit from the promotional cycle baked into this window. A non-promotional window would likely compress their hit rate advantage."* It also predicts which are stable: *"Confession, Contrarian, Shocking Statement, Warning — tactics that work off cognitive surprise rather than promotional context — would remain consistent performers regardless of season."* **Encode seasonality as a first-class covariate, and decay genome priors with a half-life measured in weeks, not quarters.**

---

## 5. Format templates — the parameterizable library

### 5.1 The template schema Motion actually publishes (copy this)

Motion's format pages carry *fully decomposed* real ad breakdowns. This is the richest published example of what a machine-usable ad template looks like. From <https://motionapp.com/library/formats/problem-agitation> (Everyday Dose and Spacegoods examples), the fields are:

```
# Ad summary
# Brand positioning      (functional vs emotional; what norm the brand pushes against)
# Product                (what it is, who for, USPs, how consumed, purchase barrier addressed)
# Visual style           (production tier, editing style, pacing, whether cuts are music-locked)
# Hooks
    Spoken:       00:00-00:02 "<exact words>"
    Text overlay: 00:00-00:02 "<exact on-screen copy>"
    Visual:       00:00-00:02 <full scene description: subject, wardrobe, set, action>
# Funnel stage           (e.g. "Middle of funnel (Consideration)")
# Pain points            (+ the verbatim line from the ad that expresses it)
# Value propositions
# Benefits
# Features
# Call to action         (verbatim, or "None used.")
# Social proof           (or "None used.")
# Point of view          (percentage split, e.g. "Customer 100%" or "Brand 80% / Customer 20%")
# Storyline              (timestamped beat list: 00:00-00:08, 00:08-00:14, ...)
```

Two things here are non-obvious and worth stealing:

- **`Point of view` as a percentage split.** "Brand 80% – The brand's official voice is used to explain the product. Customer 20% – The ad shows people experiencing the benefits." This is a *continuous* genome dimension that captures the UGC-vs-brand-film question far better than a binary flag.
- **The timestamped storyline is the generation target.** It is directly what you hand a video model. A real example, from the Spacegoods ad on that page:

```
00:00-00:01  Man walks with bloated stomach: "This you? 🤔"          [hook: confession/relatability]
00:01-00:02  Cut to intestine graphic, text "5-20 lb. of poop"       [shocking-in-problem]
00:02-00:07  Man cutting apples: claim + symptom list                 [problem agitation]
00:07-00:16  Mechanism explanation (why digestion slows)              [explainer]
00:16-00:19  "Nobody wants that."                                     [agitation close]
00:19-00:25  Product introduced as resolution                         [solution]
00:25-00:29  Free gift-with-purchase mention                          [offer sweetener]
00:29-00:35  Ingredient stack                                         [credibility]
00:35-00:40  Usage demonstration + text                               [demo]
00:40-00:49  Benefit list ("no more bloating, gas...")                [benefit stack]
00:49-00:52  Risk-reversal close: "nothing to lose except..."         [CTA]
```

Note that this winning ad is **52 seconds**, not 5–15 (see §5.6).

### 5.2 The full visual-format taxonomy — 113 values with definitions

Source: <https://motionapp.com/library/formats/> (index states "113 Visual ad formats · 578K Creatives analyzed · $1.29B Meta ad spend"; the sitemap at <https://motionapp.com/library/sitemap.xml> lists 120 `/library/formats/*` URLs including the index, `none` and `other`). Each has its own page with "definition, medium, funnel fit, mechanic pairings, and a live gallery of brand examples." **[VENDOR-CANON]**

**This is the enum to encode.** Definitions are the vendor's own:

| Format | Definition |
|---|---|
| Advent Calendar | Daily reveal calendar format, typically seasonal or promotional |
| AirDrop Mockup | Apple AirDrop notification mockup |
| Alarm App Mockup | Mobile alarm or clock app interface |
| Animation | Computer-generated animated visuals incl. 2D, 3D, motion graphics, illustrated animation |
| App Mockup | Screenshot or simulated mockup of an app interface |
| ASMR | Sensory sound-first |
| Before and After | Side-by-side transformation |
| Behind The Scenes | Insider brand access |
| Billboard | Outdoor billboard-style ad |
| Branded Asset | Primarily features brand-specific elements such as logos or wordmarks |
| Calendar App Mockup | Digital calendar interface displaying dates, events, or scheduling information |
| Cartoon | Featuring cartoon-style characters or artwork |
| Case Study | Real customer success story with proof |
| Celebrity | Endorsed by a celebrity |
| Certification Badge | Trust badge or certification seal |
| Chalkboard | Content on a chalkboard surface for educational or nostalgic effect |
| ChatGPT | ChatGPT interface mockup |
| Checkout Mockup | Shopping cart or payment screen mockup |
| Cinematic B-Roll | Polished cinematic shots |
| Collage | Freeform scrapbook layout |
| Comic Strip | Illustrated panel(s) telling story in a comic book format |
| Comment Response | Reply to social comment |
| Contest | Contest or competition format |
| Countdown | Urgency timer graphic |
| Demo | Product use demonstration |
| Document Mockup | Looks like a receipt, form, or official document |
| Duet | Split-screen TikTok-style reaction |
| Editorial | High-production fashion photography with magazine-style aesthetic |
| Educational | Informative teaching content |
| Email Mockup | Inbox or email screenshot mockup |
| Event Announcement | Event promo with key details |
| Expert Explainer | Authority-led explanation |
| FAQ | Common questions answered |
| Feature Benefit Pointout | Feature/benefit callouts |
| Flatlay | Overhead shot of items artfully arranged on flat surface |
| Founder | Message from the founder |
| Frame | Content presented within a decorative or stylized border or frame |
| Gamification | Game-like format with playable mechanics or game aesthetic |
| Giveaway | Offering free prizes |
| Graphic Overlay | Graphics, text, or icons layered over content |
| Greenscreen | Speaker with digital background |
| Grid Swap | Uniform grid layout |
| Hand-Drawn | Sketch aesthetic with notebook doodles or hand-drawn illustrations |
| Headline | Headline is central focus |
| How To | Step-by-step tutorial |
| Humor | Quick comedic moment |
| Illustration | Hand-drawn or designed artistic visual with illustrative style |
| Influencer Endorsement | Influencer-driven endorsement |
| Infographic | Animated data visualization |
| Journal Entry | Personal written entry styled as journal or diary page |
| Letter | Personal brand message |
| Lifestyle Image | Product shown in everyday use |
| Listicle | Numbered list format |
| Meme | Meme-style parody |
| Model Shot | Professional model showcasing the product |
| Montage | Fast-cut sequence |
| Music Player Mockup | Digital music player or streaming app interface display |
| Native Search | Google-style search mockup |
| News Broadcast | Content styled as news broadcast, article or report with graphics |
| None | Unformatted |
| Nostalgia | Retro throwback aesthetic |
| Notes App | Apple Notes-style text |
| Offer-First Banner | Prominent discount banner |
| Other | Other visual ad formats |
| Pattern Interrupt | Surreal disruptive visual |
| Phone Call Mockup | Incoming phone call screen interface mockup |
| Podcast | Podcast-style setup |
| Post It | Sticky note overlay |
| POV | First-person perspective |
| Press | Media coverage highlight |
| Problem Agitation | Highlighting user frustrations |
| Product Image | Clean product photo highlighting details |
| Quiz | Interactive Q&A format |
| Reaction Video | Authentic first reaction |
| Review | Customer review highlight |
| Screen Recording | App/website walkthrough |
| Sign | Handheld or posted sign |
| Skit | Scripted mini-story |
| Slideshow | Still image sequence |
| Social Comments | Screenshot of comments |
| Social Media Mockup | Mockup of social post interface (Instagram, Twitter, TikTok) |
| Social Proof Mashup | Multiple customer reviews in one |
| Split Screen | Side-by-side video/text |
| Spokesperson | Direct-to-camera message from a person |
| Static To Video Hybrid | Still-to-motion transition |
| Statistic | Standalone numerical claim |
| Stitch | Sequential TikTok-style stitch |
| Stop Motion | Frame-by-frame animation |
| Storytime | Creator recounts personal narrative in a storytelling format |
| Street Interview | Public Q&A format |
| Studio Shot | Pro studio photo with clean lighting |
| Testimonial | Customer's personal story |
| Text Message | SMS/chat-style mockup |
| Text Overlay | Text overlaid on video or image as primary message delivery |
| Time Lapse | Accelerated progress footage |
| Transformation | Progressive glow-up journey |
| Trend | Uses trending format or audio |
| Try-On | Person trying on and showcasing clothing or products |
| UGC Overlay | Casual photo with overlay text |
| UGC Selfie | Casual selfie photo |
| UI Mockup | Screenshot or simulated digital interface incl. apps, notifications, system alerts |
| Unboxing | Product package reveal |
| Unconventional Text Placement | Text in unexpected location |
| Us Vs Them | Competitive side-by-side |
| Video Sales Letter | *(listed without definition on the index)* |
| Vlog | Personal video blog documenting daily activities or experiences |
| VSL | Structured long-form persuasion designed to convert |
| Warning Screen | Alert or warning message styled as system or safety notification |
| Weather App Mockup | Weather application interface showing forecast or conditions |
| Website Mockup | Mockup of website or web page |
| Whiteboard | Hand-drawn explanations on whiteboard surface |
| Yapper | Native-feeling, personality-led storytelling that embeds selling inside conversation |
| YouTube Mockup | YouTube interface or video thumbnail mockup |

Observations that matter for a generator:
- **~18 of the 113 are UI/interface mockups** (AirDrop, Alarm App, App, Calendar App, ChatGPT, Checkout, Document, Email, Music Player, Native Search, Notes App, Phone Call, Social Media, Text Message, UI, Weather App, Website, YouTube). These are the cheapest formats to generate deterministically — they are template compositing, not video synthesis. **This is where an automated system has the largest cost advantage over a human shop.**
- `Video Sales Letter` and `VSL` are **both** present as separate slugs (`/formats/video-sales-letter` and `/formats/vsl`). Likely a taxonomy duplicate. **[UNVERIFIED]** — dedupe before use.
- `None` and `Other` are real enum members, not nulls. Preserve them; "unformatted" is a legitimate and sometimes winning choice.

### 5.3 Format → funnel stage mapping (published, encode directly)

From the formats index FAQ ("How do I pick the right format for a campaign?"):

| Funnel stage | Rewarded formats (verbatim) |
|---|---|
| **TOF (cold traffic)** | Pattern Interrupt, ASMR, Trend, Meme |
| **MOF (consideration)** | Demo, Before & After, Testimonial, Listicle |
| **BOF (conversion)** | Review, Statistic, Press, Social Proof Mashup |

And the purpose-based mapping from the Creative Strategy Engine (<https://motionapp.com/library/frameworks/creative-strategy-engine>, Part 5):

| Format purpose class | Best awareness stages |
|---|---|
| Formats that **educate and reveal** | Unaware, Problem-Aware |
| Formats that **compare and demonstrate** | Solution-Aware, Product-Aware |
| Formats that **prove and build trust** | Problem-Aware → Most-Aware |
| Formats that **drive action** | Product-Aware, Most-Aware |

With the escape hatch, which you should encode as "prefer, don't forbid":

> "Any specific format can work at any stage if the messaging is right — it's about the strategic alignment between what the format naturally does and what the stage needs to accomplish."

### 5.4 Asset type — the medium/production-tier axis (15 values)

Ordered by hit rate in the 2026 dataset (<https://motionapp.com/library/research/creative-benchmarks-2026/top-asset-types>), hit rates spanning **~4–12%**:

`Text only` → `Product image with text` → `Lifestyle-product image` → `UGC` → `High production` → `GIF` → `Illustration` → `UGC mashup` → `Lifestyle-product image with text` → `Lifestyle image with text` → `Lifestyle image` → `Hybrid` → `Product image` → `Animation` → `Carousel`

Ordered by spend use ratio (**~0.5–1.9**):

`Text only` → `Product image with text` → `Illustration` → `UGC` → `Lifestyle-product image with text` → `Lifestyle image with text` → `UGC mashup` → `Hybrid` → `Product image` → `High production` → `GIF` → `Lifestyle image` → `Lifestyle-product image` → `Animation` → `Carousel`

**This is the most counterintuitive finding in the dataset and it is directly contrary to the premise of a video-generation platform, so read it carefully:**

> "The top of the list is text-forward and UGC-forward — **not high-production**."
> "High-production assets sit in the **middle** of the hit-rate leaderboard, not the bottom."
> "**Carousel** under-captures spend relative to volume share" — last on both leaderboards.

The three stated mechanisms:
1. **Speed and clarity** — "a text-forward creative communicates the offer, the proof, and the CTA without requiring the viewer to parse a more elaborate visual."
2. **Iteration velocity** — "Text assets can be re-produced and re-tested in hours. A high-production video takes days or weeks."
3. **Low production floor** — "The cheapest text-only creative can still win. The cheapest high-production creative usually doesn't."

And the stated portfolio role assignment:

| Layer | Asset types | Job |
|---|---|---|
| Winner-discovery | Text-forward, UGC | Primary testing layer |
| Workhorse | Lifestyle-product images, Hybrid, GIF | Middle volume |
| Brand anchor / scaling | High production, Animation | Credibility; **upgrade proven angles** |

> "A text-forward asset that identifies a winning creative angle can be 'upgraded' to a high-production version once the angle is proven. **High production is sometimes more useful as a second stage than as a first test.**"

**Direct architectural consequence — this should change your build.** Mechanism 2 collapses for an AI system: your generation cost and latency for "high production" video approach those of a static. That partially neutralises the *velocity* advantage of text-forward assets — but not mechanisms 1 and 3. The right design is:

- **Stage 1 (angle discovery):** generate cheap text-forward and UGC-style statics/short videos at high volume to find the winning `(angle, hook_tactic, offer)` triple. This is where 15 cents of image generation beats 15 dollars of video generation.
- **Stage 2 (scale):** only *after* an angle proves out, spend real video-generation budget rendering it as a high-production or long-form asset.

A system that opens with expensive generated video on unproven angles is burning money at the exact point where the data says production value is least useful. **Do not skip stage 1 because you can technically afford stage 2.**

Caveat the source states itself: *"'High production' covers a wide range of quality and cost. The dataset doesn't separate $10K-production assets from $100K-production ones."* And: *"Sep 2025 – Jan 2026 includes BFCM. Text-forward and offer-heavy asset types are particularly well-suited to the promotional cycle."*

### 5.5 The measured format leaderboard (CH-009)

Condensed table as published (only segments with >=50 accounts):

| Visual format | Winners | Mid-range | Hit rate % | % of creative | % of spend | Spend use ratio |
|---|---|---|---|---|---|---|
| **Offer-First Banner** | 1,100 | 3,944 | **8.6** | **21.9** | **29.3** | 1.3 |
| Demo | 556 | 2,855 | 8.1 | 12.6 | 12.9 | 1.0 |
| Testimonial | 507 | 3,051 | 6.5 | 13.3 | 13.3 | 1.0 |
| **Unboxing** | 136 | 820 | **9.8** | 2.1 | 2.8 | 1.3 |
| **Celebrity** | 58 | 335 | 5.9 | 0.8 | 1.8 | **2.1** |

Additional SUR values from the index page: **Letter ~1.7x**, **Unconventional Text Placement ~1.5x**, **Post It ~1.3x**.

Full hit-rate rank order (approximate, hit rates ~5–9%):
`Offer-First Banner` · `Demo` · `Testimonial` · `Headline` · `Montage` · `Before & After` · `Listicle` · `Split Screen` · `Us vs Them` · `Unboxing` · `Feature Benefit Point` · `Cinematic B-Roll` · `Grid Swap` · `Screen Recording` · `Problem Agitation` · `Review` · `How-To` · `POV` · `Behind the Scene` · `Founder` · `Statistic` · `Influencer Endorsement` · `Collage` · `Static-to-Video Hybrid` · `Expert Explained`

Full SUR rank order (~0.9–2.1): `Celebrity` · `Letter` · `Unconventional Text Placement` · `Post-It` · `Offer-First Banner` · `Unboxing`

The report's own caveat on the leader: *"Offer-First Banner performance is likely elevated relative to steady-state because the window over-represents promotional periods."* **Do not make Offer-First Banner your default format in March.**

### 5.6 The video-length contradiction — resolve it explicitly

| Claim | Source | Status |
|---|---|---|
| "Facebook recommends keeping video ads between **5 and 15 seconds**" | <https://www.foreplay.co/post/how-long-should-a-facebook-video-ad-be> | **[FOLKLORE]** — attributed to "Facebook recommends" with no link; Meta's own pages unscrapeable |
| "Featuring your brand within the first 3 seconds… can increase brand recall by **23%**" | same page | **[FOLKLORE]** — reads like a Facebook IQ statistic; no primary source given |
| Actual winning DR ads decomposed on Motion's format pages | 47 s, 52 s, and similar | **[DATASET-adjacent]** — these are real ads from real accounts |
| `VSL` = "Structured **long-form** persuasion designed to convert" is a first-class format in the 113-value taxonomy | <https://motionapp.com/library/formats/> | **[VENDOR-CANON]** |

**Resolution:** the 5–15 s guidance is awareness/brand-lift guidance, not DR guidance. DR video on Meta routinely runs 30–60 s and the taxonomy explicitly contains a long-form persuasion format. **Encode duration as a per-format parameter with a range, never a global constant.** Suggested defaults, derived from the decomposed examples and format definitions — **[INFERRED]**, validate empirically:

| Format class | Typical duration |
|---|---|
| Offer-First Banner, Headline, Statistic, Countdown, Post-It | 0 s (static) or 3–8 s |
| Unboxing, ASMR, Pattern Interrupt, Meme, Trend | 6–15 s |
| Demo, Before & After, Us vs Them, Split Screen, Listicle | 15–30 s |
| Testimonial, Problem Agitation, Founder, Storytime, Yapper | 30–60 s |
| VSL / Video Sales Letter | 60 s–5 min+ |

### 5.7 Ten canonical templates, fully parameterised

These are the shapes that recur across the winner leaderboards. Each is given as a **beat table** (the generation target), a **genome default block**, **copy slots**, and **validators** you can run automatically. Timings are for the stated `duration_s` and scale proportionally.

Legend for beat tables: **SPOKEN** = VO/on-camera line · **OVERLAY** = burned-in text · **SHOT** = camera/composition · **BEAT** = narrative function.

Sourcing note: the beat structures are assembled from the decomposed real ads on Motion's format pages (§5.1), the format definitions (§5.2), the hook-writing framework (§3.6/§6.3), and named practitioner formats (§8.3). Timings are **[INFERRED]** and should be treated as starting parameters, not findings.

---

#### T1 — Talking-Head Testimonial
`visual_format: testimonial` · `asset_type: ugc` · measured: **6.5% hit rate, 13.3% of creative, SUR 1.0** — a workhorse, not a breakout.

```yaml
awareness_fit:   [product_aware, most_aware]     # "prove and build trust"
funnel:          MOF-BOF
mechanic:        social_witness | reframe
hook_tactic:     [confession, social_proof, relatability]
spokesperson:    customer                        # NEVER synthetic — see validators
duration_s:      30
pov_mix:         {customer: 1.0}
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–2 | Hook: confession / skeptic admission | Handheld selfie, eye contact, mid-sentence | "Okay so I was completely skeptical about this…" | `{hook_line}` (≤6 words) |
| 2–6 | Prior state / failed alternatives | Same, slight reframe | "I'd tried {alt_1}, {alt_2}, nothing worked" | `{pain_label}` |
| 6–12 | Discovery moment (real-life context) | Cut to product in situ | "Then my {relation} sent me this" | — |
| 12–20 | Specific result with a **timeframe** | B-roll of use + result | "Three weeks in and {specific_outcome}" | `{result_stat}` |
| 20–26 | Objection handled | Back to face | "And no, it's not {objection}" | — |
| 26–30 | Soft CTA + offer | Product hero + end card | "Link's below, they're doing {offer}" | `{offer}` + `{cta}` |

**Copy slots:** `hook_line`, `pain_label`, `alt_1..n`, `specific_outcome`, `result_stat`, `objection`, `offer`, `cta`.
**Validators:** result must include a number **and** a timeframe; at least one hedge/self-correction present (§9.2); no AI-tell words; `spokesperson_type != synthetic` **hard-blocked** unless reframed as narrator (FTC — §8.4).

---

#### T2 — Problem-Solution Demo
`visual_format: problem_agitation` → `demo` · measured: Demo **8.1% hit rate, SUR 1.0**; co-occurs with Problem Agitation **19%** of the time (§4.3).

```yaml
awareness_fit:   [problem_aware, solution_aware]
funnel:          MOF
mechanic:        contrast_without_comment | borrowed_enemy
hook_tactic:     [shocking_statement, explainer, if_then]
duration_s:      45
pov_mix:         {brand: 0.8, customer: 0.2}
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–1 | **Shocking-in-problem** visual | Extreme close-up of the problem | "{provocation}" | `{provocation}` |
| 1–3 | Stat / visceral proof of scale | Graphic or prop metaphor | "{stat_line}" | `{stat}` |
| 3–10 | Agitate: symptom list | Presenter, casual setting, hands busy | "If you're dealing with {sym_1}, {sym_2}, {sym_3}…" | — |
| 10–18 | **Mechanism** — why it happens | Diagram / demonstrative prop | "Here's what's actually going on…" | — |
| 18–24 | Product enters as the resolution | Product reveal, held in frame | "That's why I use {product}" | `{product_name}` |
| 24–32 | Demonstration of use | Macro, real hands, real time | "{usage_line}" | — |
| 32–40 | Benefit stack (3–5 items) | Quick cuts, one per benefit | "No more {b1}, {b2}, {b3}" | one line per benefit |
| 40–45 | Risk-reversal close | End card | "{guarantee}. {cta}" | `{offer}` + `{cta}` |

**Copy slots:** `provocation`, `stat_line`, `sym_1..3`, `mechanism`, `product_name`, `usage_line`, `b1..5`, `guarantee`, `offer`, `cta`.
**Validators:** the mechanism beat must exist (this is what separates Demo from a product montage); `product_name` must not appear before t=18 s; benefit lines ≤5 words each.

---

#### T3 — Unboxing
`visual_format: unboxing` · measured: **9.8% hit rate — the highest single format** — but only **2.1% of creative volume**, SUR **1.3**. Under-used relative to result.

```yaml
awareness_fit:   [product_aware, most_aware]
funnel:          BOF
mechanic:        implied_answer | this_and_a
hook_tactic:     [newness, curiosity, exclusivity]
duration_s:      12
pov_mix:         {customer: 1.0}
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–1.5 | Sealed package, hands entering frame | Overhead, tight | "It's here." | `{anticipation_line}` |
| 1.5–4 | The open — satisfying tactile moment | Macro, natural sound up | *(diegetic sound only)* | — |
| 4–7 | Reveal + first reaction | Face + product in one frame | "Oh — okay, this is {reaction}" | — |
| 7–10 | Detail pass (2–3 features) | Macro pans | "{feature_1}… {feature_2}" | feature labels |
| 10–12 | Offer/CTA | Product hero | "{offer}" | `{offer}` + `{cta}` |

**Copy slots:** `anticipation_line`, `reaction`, `feature_1..3`, `offer`, `cta`.
**Validators:** beat 2 must have **no VO** (the sound *is* the hook — but the overlay must still carry meaning for sound-off viewers, §3.5); total duration ≤15 s.

---

#### T4 — Before / After (policy-constrained)
`visual_format: before_and_after` (top-10 by hit rate) · closely related: `transformation`.

```yaml
awareness_fit:   [problem_aware, solution_aware, product_aware]
funnel:          MOF
mechanic:        contrast_without_comment          # the defining mechanic
hook_tactic:     [contrast, bold_claim, statistic]
duration_s:      15
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–2 | "Before" state, unflattering but honest | Fixed camera, same framing as After | — | `BEFORE` + `{date_1}` |
| 2–4 | Hard cut / wipe to "After" | **Identical framing, lighting, distance** | — | `AFTER` + `{date_2}` |
| 4–9 | Alternating A/B toggle ×2–3 | Same | "{elapsed_time}" | `{elapsed_time}` |
| 9–13 | What changed (product, briefly) | Product in the same room | "{one_line_explanation}" | — |
| 13–15 | CTA | End card | "{cta}" | `{offer}` + `{cta}` |

**Policy constraints — this template carries the highest rejection and legal risk of the ten:**
- Meta restricts before/after imagery for **health, weight-loss, and cosmetic-outcome** claims. Treat any `vertical ∈ {health, weight_loss, cosmetic, supplements}` as **requiring human review** before publish. Verify current wording against Meta's Advertising Standards (unscrapeable this session — **[UNVERIFIED]**; see `meta-policy-compliance.md`).
- Under the FTC Reviews & Testimonials Rule, a before/after that implies a **typical** result needs substantiation. If the subject is **AI-generated**, this is a fabricated testimonial — **hard-block** (§8.4).
- The mechanic requires *no editorial comment*: the script must contain no evaluative sentence about the two states.

**Validators:** identical framing metadata (focal length, distance, lighting) between the two states; `synthetic_presenter == false`; vertical not in the restricted set, or `human_review_required = true`.

---

#### T5 — Listicle / "3 Reasons Why"
`visual_format: listicle` (top-10 by hit rate) · practitioner note: *"top three reasons why you should purchase in less than 30 seconds"* — stated as working in **almost any industry** (§8.3).

```yaml
awareness_fit:   [solution_aware, product_aware]
funnel:          MOF
mechanic:        implied_answer
hook_tactic:     [listicle, reasons_why, directive]
duration_s:      25
n_items:         3          # 3 outperforms 5 at DR lengths — [INFERRED]
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–2 | Numbered promise | Presenter, direct address | "Three reasons {audience} switch to {product}" | `3 REASONS` |
| 2–8 | **Reason 1** — the strongest one first | Cut to proof shot | "One — {reason_1}" | `1. {reason_1_short}` |
| 8–14 | **Reason 2** | New proof shot | "Two — {reason_2}" | `2. {reason_2_short}` |
| 14–21 | **Reason 3** — the objection-killer | New proof shot | "And three — {reason_3}" | `3. {reason_3_short}` |
| 21–25 | CTA | End card | "{cta}" | `{offer}` + `{cta}` |

**Copy slots:** `audience`, `product`, `reason_1..3` (spoken, ≤12 words), `reason_*_short` (overlay, ≤4 words), `offer`, `cta`.
**Validators:** the on-screen number must appear at the start of each item (this is the format's whole legibility mechanism); each reason must be a **distinct benefit category** (not three phrasings of one); strongest reason first — do not save it for last, viewers drop off.

---

#### T6 — Founder Story
`visual_format: founder` (top-25 by hit rate) · **strongly vertical-dependent: top-5 in Health & Wellness, absent from Fashion's top 10** (§13.2).

```yaml
awareness_fit:   [unaware, problem_aware, solution_aware]
funnel:          TOF-MOF
mechanic:        reframe | borrowed_enemy
hook_tactic:     [confession, contrarian, belief, authority]
spokesperson:    founder
duration_s:      45
pov_mix:         {brand: 0.5, founder: 0.5}
gate:            vertical in {health_wellness, supplements, finance, b2b_saas, education}
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–3 | Contrarian or confessional opener | Founder, unpolished, real workspace | "I'm going to say something that'll annoy {industry}" | `{hook_line}` |
| 3–10 | Personal origin of the problem | Same, or archival/B-roll | "{origin_story}" | — |
| 10–20 | What the industry gets wrong (the borrowed enemy) | Cutaway to the failed alternative | "Everyone does {wrong_practice} because {cynical_reason}" | — |
| 20–30 | What we did instead | Product/process B-roll | "So we {differentiating_choice}" | `{differentiator}` |
| 30–40 | Proof: cost, certification, sourcing, data | Documents / lab / supply chain | "{proof_point}" | `{proof_stat}` |
| 40–45 | Direct ask | Founder, eye contact | "{cta}" | `{offer}` + `{cta}` |

**Validators:** the "wrong practice" must be a **practice**, not a named competitor (naming invites both policy and legal problems); `proof_point` must be verifiable and stored with a substantiation reference; founder must be a real, identified person.

---

#### T7 — Social-Proof Stack
`visual_format: social_proof_mashup` · also `social_comments`, `review`, `press` · these are the **BOF** cluster (§5.3).

```yaml
awareness_fit:   [product_aware, most_aware]
funnel:          BOF
mechanic:        social_witness
hook_tactic:     [social_proof, statistic, authority]
duration_s:      15
asset_type:      hybrid            # screenshots + light motion; cheap to generate
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–2 | Aggregate proof number | Full-bleed number | "{n} people have {action}" | `{n_reviews}` ★ `{avg_rating}` |
| 2–5 | Review card 1 — the objection-killer | Screenshot, highlight-animated | *(VO reads it)* | verbatim quote |
| 5–8 | Review card 2 — the outcome | Same | *(VO reads it)* | verbatim quote |
| 8–11 | Review card 3 — the surprise/delight | Same | *(VO reads it)* | verbatim quote |
| 11–13 | Press / certification badge row | Logo strip | "{authority_line}" | badges |
| 13–15 | CTA | End card | "{cta}" | `{offer}` + `{cta}` |

**Validators:** every quote must map to a **real, retrievable review ID** stored in provenance — fabricated reviews are squarely inside the FTC rule; ratings and counts must be current; press logos require actual coverage.

---

#### T8 — Offer-Led / Offer-First Banner
`visual_format: offer_first_banner` · **the volume-and-performance leader: 8.6% hit rate, 21.9% of all creative, 29.3% of all spend, SUR 1.3.** Also the most **seasonally inflated** — see §5.5 caveat.

```yaml
awareness_fit:   [most_aware]
funnel:          BOF
mechanic:        this_and_a
hook_tactic:     [offer_only, sale_announcement, price_anchor, urgency, fomo]
duration_s:      0            # static is the canonical form
asset_type:      product_image_with_text     # #2 by hit rate AND by SUR (§5.4)
gate:            requires an actual offer; do NOT generate when offer_type == none
```

**Static composition slots (this is a layout template, not a beat table):**

| Zone | Content | Constraint |
|---|---|---|
| Top third | `{offer_headline}` | ≤5 words, largest type in the frame |
| Middle | Product hero on a clean or lifestyle ground | Product must be identifiable at thumbnail scale |
| Lower-middle | `{qualifier}` (code, minimum spend, dates) | Legible but subordinate |
| Bottom band | `{urgency_line}` + `{cta}` | Must sit **above** the 35% bottom safe zone (§3.5) |

**Video variant (3–8 s):** offer headline burned in at t=0 (not revealed), one product motion beat, urgency line, end card.

**Validators:** offer must be **real and currently live** on the landing page — offer/LP drift is the most common cause of a policy strike and a wasted click; `{qualifier}` must state every material condition; **do not** default to this format outside a promotional window (§4.6).

---

#### T9 — Comparison / "Us vs Them"
`visual_format: us_vs_them` (top-10 by hit rate) · related: `split_screen` · noted as *"work across budgets and are common high-performers"* (§6.3).

```yaml
awareness_fit:   [solution_aware, product_aware]
funnel:          MOF-BOF
mechanic:        contrast_without_comment | borrowed_enemy
hook_tactic:     [contrast, us_vs_them, myth_busting, price_anchor]
duration_s:      20
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–2 | Frame the choice | Split screen established | "{category} vs {our_approach}" | `THEM` / `US` |
| 2–7 | Dimension 1 (the one they lose worst on) | Both sides act simultaneously | "{dim_1}" | ✗ / ✓ |
| 7–12 | Dimension 2 | Same | "{dim_2}" | ✗ / ✓ |
| 12–16 | Dimension 3 — usually price or time | Same | "{dim_3}" | ✗ / ✓ |
| 16–20 | Verdict + CTA | Collapse to our side | "{cta}" | `{offer}` + `{cta}` |

**Validators:** compare against a **category or practice**, never a named brand or a recognisable trade dress — Meta's policies restrict this and it invites legal exposure; each dimension must be a factual, substantiable difference; the "them" side must be a fair representation (a strawman is both a policy and a performance risk — viewers punish it in comments).

---

#### T10 — Day-in-the-Life / POV
`visual_format: pov` (top-25 by hit rate) · related: `storytime`, `vlog`, `yapper` · this is the **Trojan Horse** mechanic's natural vessel.

```yaml
awareness_fit:   [unaware, problem_aware]
funnel:          TOF
mechanic:        trojan_horse                     # product enters at ~80%
hook_tactic:     [relatability, demographic_callout, curiosity, storytelling]
duration_s:      35
product_reveal_at: 0.8                            # HARD constraint from the mechanic
```

| t (s) | BEAT | SHOT | SPOKEN | OVERLAY |
|---|---|---|---|---|
| 0–2 | Identity call-out framed as POV | Handheld, in motion | "POV: you're {specific_identity}" | `POV: {identity}` |
| 2–10 | Genuine slice of that life — no product | Real locations, natural cuts | "{routine_line}" | timestamps |
| 10–20 | The friction point, shown not stated | The moment it goes wrong | "{friction_line}" | — |
| 20–28 | Continue the day; friction persists | More real life | "{consequence_line}" | — |
| 28–33 | **Product appears as part of the resolution — not announced** | It is simply present and used | "and obviously {understated_product_line}" | — |
| 33–35 | Soft CTA | End card | "{cta}" | `{cta}` |

**Validators (mechanically checkable):** no product noun before `0.8 × duration`; `{identity}` must be specific enough to exclude most viewers (the Identity Call-Out trigger, §3.6); the product line must be **understated** — no superlatives, no benefit stack; total run of any single continuous shot ≤5 s.

---

**Two templates deliberately excluded and why.** `Carousel` is last on both the hit-rate and spend-use leaderboards (§5.4) — do not make it a default. `Celebrity` has the highest SUR (2.1) but requires a real licensed celebrity; a synthetic likeness of a real person is a right-of-publicity claim *and* an EU AI Act deepfake disclosure obligation (see `meta-policy-compliance.md`). Neither is generatable safely.

---

## 6. Hook tactics — the 33-value enum

Source: <https://motionapp.com/library/hooks/tactics/> — "The 33 Hook Tactics That Stop the Scroll." **[VENDOR-CANON]**

The crucial architectural distinction, stated by the source, is that **tactics and triggers are orthogonal layers, not competing lists**:

> "**Tactics** = the strategic frame (the *what*). **Triggers** = the emotional mechanism (the *how*). A Contrarian tactic typically runs on a Pattern Interrupt or Myth-Busting trigger. A Demographic Callout runs on Identity Call-Out. Storytelling can run on Pain Agitation, Curiosity Gap, or Social Proof."
> "Tactics are the right tool when you need a **taxonomy**… Triggers are the right tool when you're deciding **how to emotionally land** a message for a specific persona and awareness stage."

**Encode both fields.** `hook_tactic` (33 values) is your categorical for regression; `psych_trigger` (8 values, §3.6) is your generation-time control and your diversity constraint.

### 6.1 The 33 tactics with their published "when to use" condition

| Tactic | When to use (verbatim) |
|---|---|
| Aspirational | Awareness stages: Unaware, Problem-Aware |
| Authority | Health, wellness, supplements, skincare, financial products |
| Belief | Brand-building campaigns, mission-driven products, audiences who buy on values alignment |
| Bold Claim | Competitive categories where differentiation is hard |
| Call To Action First | Most-Aware audiences |
| Challenge | Audiences with a competitive or achievement-oriented identity |
| Confession | Rebuilding trust, countering skepticism, standing out in polished/corporate categories |
| Contrast | Price-sensitive audiences, upgrade messaging, competitive conquesting |
| Contrarian | Educated, skeptical, or sophisticated audiences |
| Curiosity | Top of funnel, content-led ads, any stage where the audience isn't yet emotionally invested |
| Demographic Callout | Niche products, highly segmented audiences, precision over reach |
| Direct Address | Any awareness stage |
| Directive | Problem-Aware and Solution-Aware audiences |
| Exclusivity | Premium, luxury, or invite-only products |
| Explainer | Problem-Aware audiences who don't yet understand the root cause |
| FOMO | Product-Aware audiences |
| How To | Problem-Aware and Solution-Aware audiences actively looking for solutions |
| If Then | Segmented audiences with a clear, nameable condition or situation |
| Listicle | Content-heavy campaigns, educational TOF, audiences who respond to scannable structure |
| Myth Busting | Sophisticated, educated audiences |
| Offer Only | Most-Aware audiences |
| Price Anchor | Mid-to-high ticket products |
| Question | All awareness stages depending on the question |
| Reasons Why | Solution-Aware and Product-Aware audiences who need logical justification |
| Relatability | Unaware and Problem-Aware audiences |
| Reverse Psychology | **Ad-fatigued audiences** |
| Risk Reversal | Product-Aware audiences who haven't bought due to hesitation or doubt |
| Shocking Statement | Any awareness stage |
| Social Proof | Product-Aware audiences with hesitation |
| Statistic | Skeptical, analytical audiences |
| Storytelling | Any awareness stage |
| Urgency | Most-Aware audiences |
| Warning | Problem-Aware audiences about to make a mistake |

That column is a **directly executable eligibility filter**. Given `awareness_stage` and persona attributes, you can mechanically narrow 33 → ~6 candidate tactics before you generate a single word.

Individual tactic pages carry a consistent, machine-parseable structure — e.g. <https://motionapp.com/library/hooks/tactics/price-anchor>:

```
definition:        "Frames the cost against a familiar, relatable benchmark to make the price feel smaller."
when_to_use:       "Mid-to-high ticket products. Price-sensitive audiences. Any product where sticker shock is a known barrier."
trigger_pairing:   ["pattern_interrupt", "pain_agitation"]
example:           "Less than your daily coffee."
```

### 6.2 The measured hook leaderboard (CH-011)

Source: <https://motionapp.com/library/research/creative-benchmarks-2026/top-hook-tactics>. Hit-rate band **6–11%** — the page notes this is "meaningfully above the 4–8% tier averages," i.e. *choosing a listed tactic at all* is itself a lift.

**By hit rate (approx. rank order):**
`Newness` · `Sale Announcement` · `Price Anchor` · `Urgency` · `Announcement` · `Offer Only` · `FOMO` · `New Product Announcement` · `Confession` · `Exclusivity` · `Curiosity` · `Giveaway` · `Event Announcement` · `Bold Claim` · `Reverse Psychology` · `Shocking Statement` · `If/Then` · `Warning` · `Wordplay` · `Contrarian` · `Relatability` · `Contrast` · `Direct Address` · `Product Announcement` · `Authority`

**By spend use ratio (~0.9–2.2):**
`Giveaway` · `Price Anchor` · `Announcement` · `Event Announcement` · `Offer Only` · `Confession` · `Urgency` · `Curiosity` · `FOMO` · `Wordplay` · `Contrast` · `Myth Busting` · `Call to Action First` · `Contrarian` · `Exclusivity` · `If/Then` · `Warning` · `Shocking Statement` · `Authority` · `Product Announcement` · `Sale Announcement` · `Bold Claim` · `Direct Address` · `Storytelling` · `Reasons Why`

**The two-cluster model — this is the useful abstraction:**

| Cluster | Members | Behaviour |
|---|---|---|
| **Promotional** ("why act now") | Newness, Sale Announcement, Price Anchor, Urgency, Offer Only, FOMO, New Product Announcement, Event Announcement, Giveaway | High hit rate **and** high SUR in this window. Fits BOF. **Seasonally inflated.** |
| **Interrupt** ("this isn't what you expected") | Confession, Contrarian, Shocking Statement, Reverse Psychology, Warning, Myth Busting, Bold Claim | "Often lower hit rate… but with **higher variance** — when they connect, they tend to connect hard." Fits TOF. **Season-stable.** |

Portfolio guidance given verbatim, which maps cleanly onto an explore/exploit split:

> "Don't pick the top 5 and only test those… a hook library that's all 'Sale Announcement' will fatigue your audience fast."
> "Portfolio approach: **lead with the reliable hit-rate tactics, keep a consistent testing slot for the higher-variance ones.**"

**Encode as: exploit budget on the promotional cluster when a promo is live; a *fixed, non-negotiable* exploration slot (suggest 20–30% of weekly launches) on the interrupt cluster year-round.** Because interrupt tactics are high-variance, a greedy bandit will starve them; the fixed floor is what prevents that.

Also stated: *"Not ROAS-weighted: Rankings use hit rate and spend use ratio; they don't measure ROAS impact. A high hit rate hook that generates spend without conversion isn't separated here."*

### 6.3 Awareness-stage hook adaptation (the 5-stage rewrite rule)

From `hook-writing`, using Eugene Schwartz's five stages. **The messaging angle stays constant; only the expression changes.** This is the single highest-leverage generation rule in the document because it turns one strategic input into five ads with genuinely different content:

| Stage | Audience state | Hook strategy | Example (angle: "Your dermatologist wrecked your skin") |
|---|---|---|---|
| **Unaware** | Doesn't know they have a problem | Introduce pain/desire via relatable situation or unexpected observation. **No product mention.** | "If your skin is worse after seeing the dermatologist…" |
| **Problem-Aware** | Knows the problem, no solution found | Agitate hard. Make them feel deeply understood. Build urgency. | "Why does your prescription burn more than your acne?" |
| **Solution-Aware** | Comparing options | Differentiate. Position against alternatives. Call out what's failed them. | "Natural treatments that heal without destroying your skin barrier" |
| **Product-Aware** | Knows you, hasn't bought | Remove objections. FOMO. Social proof. Counter the reason they haven't bought. | "Magic Healer vs your dermatologist's prescription" |
| **Most-Aware** | Ready, needs a nudge | Direct offer, urgency, guarantee, price anchoring. CTA-forward. | "Get Magic Healer with our 30-day guarantee" |

Budget-dependent stage prioritisation, from the Creative Strategy Engine:

> "**Lower budgets:** Start with Problem-Aware and Solution-Aware — find people already aware they have a problem… More efficient conversion with limited spend."
> "**Scaling budgets:** Invest heavily in Unaware content… Requires more spend but unlocks growth."
> "'Us vs Them' comparisons work across budgets and are common high-performers."

**Encode as a budget-gated stage mix.** A $2k/month account generating Unaware content is wasting money; a $200k/month account generating only Most-Aware content has capped its own growth.

---

## 7. Creative mechanics — the missing middle layer (8 values)

Source: <https://motionapp.com/library/creative/mechanics/> **[VENDOR-CANON]**

> "Creative mechanics are the structural patterns that define **how an ad constructs meaning** between its hook, visuals, and narrative. They are not hook tactics (what the ad says) and not visual formats (what the ad looks like). They are the cognitive or emotional move that makes the concept land."

This layer is usually absent from ad-tagging schemas and it is where most of the "why did this work" signal actually lives.

| Mechanic | What it is |
|---|---|
| **The Implied Answer** | The hook poses a question that sounds like mild judgment, confusion, or curiosity. The visuals silently answer it. |
| **The Social Witness** | Someone *other than the customer* notices the change — a compliment, a double-take, an unsolicited "what are you doing differently?" |
| **The Overheard Conversation** | Framed as something you weren't supposed to see — a text thread, a DM, a group chat, a conversation between friends. |
| **The Reframe** | Opens by validating a belief the viewer already holds, then reframes it. |
| **The Borrowed Enemy** | Describes a problem/ingredient/feeling *obviously* caused by a specific competitor or category, without naming it. |
| **The Trojan Horse** | Looks like educational content, entertainment, or a personal story — until the final ~20%, where the product appears as the resolution. |
| **The Contrast Without Comment** | Shows two realities side by side (before/after, with/without, old way/new way) but never editorially tells the viewer what to conclude. |
| **This and a…** | Two things shown or named together — the product and something aspirational, unexpected, or emotionally resonant. |

Worked template for one, from <https://motionapp.com/library/creative/mechanics/trojan-horse> — note the structure is directly a generation spec:

```
mechanic:        trojan_horse
why_it_works:    "Ad avoidance is highest at the moment of recognition — 'this is an ad.'
                  The Trojan Horse delays that recognition until the viewer is already engaged.
                  By the time the product appears, it feels earned rather than inserted."
awareness_fit:   ["unaware"]   # "most powerful for cold audiences who would scroll past a traditional ad"
structure:
  - "Open as pure content: tutorial, story, observation, entertainment"
  - "Build genuine value or narrative tension with NO product mention"
  - "Product enters naturally as part of the resolution — not announced, just present"
  - "No hard sell; the content did the work"
example:         "Knife brand: opens as a genuine onion-dicing tutorial; full technique breakdown;
                  two minutes in: 'and obviously it helps that this knife actually holds an edge.'"
```

**Build note:** `The Trojan Horse` with `product_reveal_at ~= 0.8 x duration` is a numeric constraint you can validate automatically on a generated storyboard. Several of these mechanics reduce to checkable structural predicates:
- `contrast_without_comment` → the script must contain **no evaluative sentence** about the two states shown.
- `social_witness` → the praise line must be spoken by a character who is **not** the product user.
- `overheard_conversation` → the frame must be a mediated artifact (screen, thread, doorway), never direct-to-camera.
- `trojan_horse` → no product noun before the 80% mark.

---

## 8. UGC / creator-style vs polished brand film — what the evidence actually says

### 8.1 The headline finding is more nuanced than the folklore

Folklore: *"UGC always beats polished for DR."* The 2026 dataset says something more specific:

- `UGC` ranks **4th** by hit rate among 15 asset types, behind `Text only`, `Product image with text`, and `Lifestyle-product image`. **[DATASET]**
- `High production` ranks **5th** — mid-pack, explicitly "not the bottom," and "roughly tier-average."
- The genuinely dominant asset types in this window are **text-forward statics**, not UGC video.

So the correct statement is: **text-forward and UGC-forward assets out-produce high-production assets *per unit of creative output* — largely for velocity and cost reasons, not because polish is disliked.** The source says so directly: "they can be iterated faster and more cheaply."

Where high production *does* earn its place, per the same page:
- **Credibility establishment** — "signals brand maturity and seriousness. That signal matters even when the asset itself isn't the biggest winner."
- **Scaling known winners** — upgrade a proven angle.
- **Category norms** — "Some verticals (**Automotive, Technology, Finance, Travel & Hospitality**) expect high-production baseline quality. In those categories, high production is table stakes rather than differentiator."

### 8.2 UGC is a *format family*, not a single thing

The distinction Motion draws is that `asset_type = UGC` can carry many `visual_format` values: "skits, overlays, green screens, or testimonials." The taxonomy contains at least these UGC-adjacent formats: `UGC Selfie`, `UGC Overlay`, `Greenscreen`, `Skit`, `Storytime`, `POV`, `Vlog`, `Reaction Video`, `Stitch`, `Duet`, `Street Interview`, `Yapper`, `Comment Response`, `Try-On`, `Unboxing`.

Note **`Yapper`**, defined as "Native-feeling, personality-led storytelling that embeds selling inside conversation" — this is the current name for the dominant creator-ad shape and it is a *distinct* format from `Testimonial`.

### 8.3 Practitioner format library with vertical fit

From Savannah Sanchez (The Social Savannah; 200+ ads/week, 50+ clients incl. Fabletics, Bumble, Athletic Greens, Loop Earplugs) via <https://www.foreplay.co/post/savanah-sanchez-ad-formats> **[PRACTITIONER]**:

| Format | Stated ideal-for | Quoted rationale |
|---|---|---|
| **Solo Skit** (one actor, multiple roles) | Fashion, Beauty, Personal Care | "typically a really high watch time and also, of course, a great conversion rate" |
| **Greenscreen** | Tech gadgets, Educational services, Ecommerce | "it has to be a staple in your ad account" |
| **What I Ordered vs What I Got** | Fashion, Online retail, Subscription | "social proof of… when I tried it in real life, it is actually worth the hype" |
| **Fake Podcast Ads** | Educational products, Books, Thought leadership | "someone on a podcast is endorsing a product so it must be good" — exploits the learned "viral podcast clip = interesting" reflex |
| **"I Saw This on TikTok"** | Viral products, Trendy gadgets, Youth brands | FOMO |
| **Fun Facts** | Educational apps, Niche products, Health supplements | "share the most important part… in a very concise way" |
| **3 Reasons Why** | **Almost any industry** | "top three reasons why you should purchase in less than 30 seconds" |
| **Comparison** | Tech, Financial services, Beauty | "comparing to a competitor or comparing to an inefficient way of doing something is extremely effective" |
| **Car Testimonial** | Lifestyle products, Apps, Services | "something about being in the car just makes it look so authentic and makes it not look like an ad" |
| **ASMR** | Beauty, Food, Relaxation | "People will stay to watch ASMR ads" |

### 8.4 AI UGC — what's actually established, and the constraints that bite

**Evidence it works at scale [PRACTITIONER]:** Alex Cooper (AdCrate; clients incl. Huel, Licorice.com, The Perfect Jean), reported via <https://motionapp.com/blog/ai-ad-creative-alex-cooper>:

> "A lot of people tell him they'd never use AI in their ads because it's so obvious and fake, their customers would spot it right away… Yet **AdCrate continues to create ads with AI that profitably scale to $100k+ in spend.**"

**Evidence about *how* to do it — the single most actionable line found on AI UGC:**

> "Don't just take the video it produces and throw it in your ad account. **The technology isn't quite there yet.** Alex and his team like to **mix in b-roll and product shots to flesh out the video and make the AI creator blend in.** You can also splice in other creators."

**Encode this as a hard pipeline constraint, not a style preference:** an AI-avatar talking-head shot must never occupy a contiguous block longer than ~N seconds without a cutaway. Suggested `max_contiguous_avatar_seconds ~= 3-5` with mandatory interleaved product macro / b-roll / screen-recording. **[INFERRED]** from the above — the exact number is unverified, but the *structure* (interleave, don't run) is explicitly stated. This is also what makes the uncanny-valley failure mode tractable: the artefacts that break the illusion (hand morphing, teeth, blink cadence, lip-sync drift) accumulate over duration, so cutting away resets the budget.

The referenced tooling class: ArcAds — "partners with real creators who authorize their likenesses for marketing purposes. You pick a creator, give them a script, and the AI generates a video of them reading it." That licensing model matters legally (see below).

**The three constraints that actually bind — all documented in the companion policy dossier, restated here because they are creative-design constraints, not just legal ones:**

1. **Meta will label photorealistic AI humans *next to the Sponsored label*, not behind the three-dot menu.** Per `meta-video-creative.md` §13.2, citing <https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/>: *"When AI-generated photorealistic humans are included, the label will appear next to the Sponsored label (not behind the three-dot menu)."* Automated third-party-AI detection has been live since **2026-06-01**. **The creative consequence:** the "authentic customer" illusion an AI-UGC ad depends on is broken *by the platform itself, in the ad chrome, at first exposure*. Any strategy premised on the viewer not knowing is already dead on Meta. Design AI presenters as **openly synthetic presenters**, not as fake customers.

2. **FTC Reviews & Testimonials Rule.** Per `meta-policy-compliance.md`: an AI-generated person saying "this product changed my life" is a **fabricated consumer testimonial**, AI mass-generation was the named motivating harm, the rule carries civil penalties, and **Meta approving your ad is not a defence**. The hard rule already encoded in that dossier and repeated here because it constrains every template in §5: *any synthetic on-screen presenter must be framed as a presenter/spokesperson/narrator, never as a customer recounting a personal result.*

3. **EU AI Act Art. 50(4)** requires deployer disclosure for deepfakes, and Meta's own "About this ad" label sits behind a menu and therefore does **not** satisfy "clear and distinguishable at first exposure." For EU delivery you need an **in-creative** disclosure (burned-in caption or first-frame supertitle).

**Net creative-design rule for AI UGC, encode as a template-level flag:**

| Template uses a synthetic human presenter? | Allowed framings | Forbidden framings | Required overlays |
|---|---|---|---|
| Yes | Narrator, host, explainer, spokesperson, animated/stylised character | First-person customer result ("I lost 20 lbs"), before/after with the synthetic person as the subject, "real customer" framing | "AI-generated presenter" style disclosure where it could read as testimonial; in-creative disclosure for EU delivery |
| No (real licensed creator, e.g. ArcAds model) | Anything the creator's licence permits | Claims the creator did not make and cannot substantiate | Licence terms retained in provenance record |

**Also creative-relevant:** Advantage+ Creative features (`music_generation`, `creative_stickers`, `image_background_gen`, `translate_voiceover` — see `meta-video-creative.md` §8.4) will **add further AI generation on top of yours unless explicitly opted out**. An ad can ship with a Meta-generated voiceover translation over your generated video, which will wreck a carefully-tuned hook. **Turn `degrees_of_freedom_spec` off for any creative whose first 3 seconds are the tested variable.**

---

## 9. Copy — the rules that are actually machine-checkable

### 9.1 Length: generate to the *minimum* across the placement set

The character budgets are established in `meta-video-creative.md` §9.2 and are **display truncation limits, not API limits** — exceeding them does not error, it truncates with an ellipsis and a "See more" affordance, which on Reels/Stories means the copy is simply never read.

| Field | Budget for a cross-placement video ad |
|---|---|
| Primary text (`message` / `bodies[].text`) | **40 chars** if the ad may serve on Facebook Reels; 44 for IG Reels; 125 if Feed/Stories only |
| Headline (`title` / `titles[].text`) | **27 chars** for FB Feed; 40 FB Stories; 55 FB Reels |
| Description (`link_description`) | Rarely rendered on video placements; <=30 chars if used |

**API limits are far larger** (`asset_feed_spec` bodies 1024 chars, titles/descriptions 255), which is precisely the trap: your generator will happily emit 300 characters and nothing will fail.

**The engineering choice:** either (a) generate to the **minimum across the placement set** (40 / 27 for a cross-placement video ad), or (b) use placement asset customization with `body_label` / `title_label` to ship per-placement copy. Option (b) is strictly better and is what an automated system should do — a human team won't bother, you can.

**Consequence for the hook:** at 40 characters, primary text cannot carry the hook. **The hook must live in the video's first frame (text overlay + visual), not in the caption.** This is why §3.5's "bold problem statement" is a burned-in overlay and not ad copy.

### 9.2 The "doesn't sound AI-written" ruleset — the most directly implementable thing found

Source: <https://motionapp.com/library/frameworks/voice-copy-standards> ("How to Write Ad Copy That Doesn't Sound AI-Written"). **[VENDOR-CANON]** This exists because AI-written ad copy has a recognisable register, and it is *published as a set of constraints*, which is exactly what you want.

**The core rule:** *"Write how people talk. Not how people write."* Plus the **Out-Loud Test**: *"Read it aloud in a normal voice. If you stumble, if it sounds stiff, if it sounds like an email — rewrite it."*

**Reading level (machine-checkable — run Flesch-Kincaid as a validator):**
- Maximum **8th grade**; aim **6th–7th** in scripts and social copy
- One idea per sentence
- **If a sentence runs past 20 words, break it up**
- "Simple words beat precise words every time"
- Rationale: *"When someone's watching a video, they can't re-read."*

**The AI Tell Word List — implement as a literal blocklist with substitutions:**

| Blocked | Replace with |
|---|---|
| view | see, look at, check out |
| leverage | use, take advantage of |
| utilize | use |
| showcase | show, prove |
| demonstrate | show |
| transform | change, shift, flip |
| foster | build, grow, create |
| delve | dig in, get into, look at |
| navigate | deal with, handle, get through |
| embark | start, kick off |
| comprehensive | full, complete, everything |
| facilitate | help, make easier, run |
| enhance | improve, make better, boost |
| garner | get, pull in, earn |
| paramount | key, most important, number one |
| pivotal | key, huge, important |
| innovative | new, different, fresh |
| robust | strong, solid, good |
| seamlessly | easily, without issues |
| actionable | useful, something you can actually do |
| streamline | simplify, cut down, make easier |
| in terms of | for, about, when it comes to |
| with respect to | for, about |
| it's important to note | *(just say the thing)* |
| it's worth mentioning | *(just say the thing)* |

**Structural AI tells — regex-checkable patterns to reject:**
`"This means that…"` · `"In conclusion…"` · `"Not only X, but also Y"` · `"Whether you're X or Y…"` (flagged as "usually a sign the persona isn't specific enough") · `"Are you tired of…?"` (overused opener) · starting with "I" as the structural default · **triple parallelism** ("It's fast, it's easy, and it's affordable") · rhetorical questions as transitions ("So what does this mean for you?") · the word **"journey"** ("Always. Cut it.") · **"game-changer"** · **"at the end of the day"**

**Spoken-language requirements (validators):**
- Contractions **always**: "you're" not "you are"
- Informal sentence-initial connectors ("and", "but", "so") are **fine**
- Strategic filler in moderation: "honestly," "literally," "actually," "I mean" — "these signal authenticity"
- Fragments and self-corrections add texture in UGC scripts
- **Never:** passive voice, nominalization ("the improvement of results" → "improving results"), corporate hedging, formal transitions ("Furthermore," "Moreover," "Additionally" — "never in scripts")
- Punctuation as breath: commas = breath, periods = full stop, em-dashes = spoken aside, ellipses = trailing thought (sparingly)

**UGC-script-specific rules — these are the ones that make synthetic UGC pass:**
- **Start mid-thought:** "Okay so I've been using this for three weeks…"
- **Emotional honesty over formality:** "I was honestly skeptical at first" beats "Initially, I had reservations"
- **Avoid perfect product explanations** — "real people fumble slightly and **round numbers**: 'like $40-something' not '$42.99'"
- **Reference real-life context:** what they were doing when they found it, why they needed it

That third rule is a genuinely non-obvious generation constraint: **price precision is an authenticity tell.** An LLM will emit "$42.99" because it is accurate. A real person says "forty-something bucks." Encode a rounding/hedging transform on numerals inside UGC scripts.

### 9.3 Caption / first-line rules

- **"Hook line must work without the video"** — assume someone reads only the caption.
- **First line: no hashtags, no emojis, no tagging — just words that earn the tap.**
- Sentence fragments fine; run-ons not.
- "Casual > polished. Always."
- Hashtags "functional, not decorative. If it doesn't help discovery, cut it."

**On emoji specifically:** the only direct guidance located is the negative one above (no emoji in the first line of a caption). Note that the Meta API explicitly supports emoji in `title`, `name` and `description` on `/advideos` (see `meta-video-creative.md` §1.2 — "Supports Emoji"), and emoji *do* appear in the winning ads decomposed on Motion's format pages — e.g. the Spacegoods text overlay `"This you? 🤔"`, which is an **on-screen overlay**, not caption copy. **I found no quantitative study of emoji lift in Meta DR ad copy this session — [UNVERIFIED].** Safe encoded default: **emoji permitted in burned-in overlays, forbidden in caption line 1, permitted sparingly after the truncation point.**

### 9.4 Text-hook vs video-hook slots

From `hook-writing`, the three text-hook slots are distinct and should be generated separately:
- **Primary text hook** — first line of ad copy
- **Headline** — overlay text on static image *(note: this is Motion's usage; in the Meta API `title` is the link headline — do not conflate them)*
- **Caption hook** — first line of caption, before "more"

### 9.5 Landing-page continuity — the diagnostic rule

> "High CTR with poor conversion indicates misalignment; your creative promise is attracting clicks, but either the wrong audience is clicking or **your landing page breaks the narrative the ad established**."
> "Let's say CTR is healthy but conversion rate is low. **Before you blame the creative, examine landing page alignment.** Does the landing page continue the narrative the ad started?"
> "If other ads are converting well with the same landing page, there's either a problem with your ad or it doesn't fit the landing page as well."
> — <https://motionapp.com/blog/key-creative-performance-metrics>

**That last sentence is the machine-executable version and it is a genuinely good test.** Encode as:

```python
if creative.ctr >= account_p50_ctr and creative.cvr < account_p25_cvr:
    peers = creatives_sharing(creative.landing_page_id)
    if median(peers.cvr) >= account_p50_cvr:
        diagnosis = "ad_lp_mismatch"       # this ad's promise != this LP
    else:
        diagnosis = "landing_page_problem" # the LP is the bottleneck for everyone
```

**Build implication:** `landing_page_id` must be a first-class genome field (it is, in §4.5) and the system must be able to attribute failure to the LP rather than the creative. Otherwise the creative loop will thrash forever against a broken page.

---

## 10. Angles vs creatives vs offers — what to vary, in what order

### 10.1 The hierarchy

The Creative Strategy Engine states the ordering explicitly:

> "**Strategic layer:** messaging angles define **WHAT** to say. **Awareness stages:** define **WHERE** people are. **Hooks:** connect strategy to execution. **Visual formats:** **HOW** to show the hook."
> "**Strategic Before Tactical.** Define the messaging angle before writing hooks. Map the awareness stages before creating content."

And the practitioner version of why this ordering matters, from Connor Rolain (Head of Growth, HexClad) via <https://motionapp.com/blog/andromeda-impact-on-bfcm> **[PRACTITIONER]**:

> "We used to make **seventy-five ads a campaign. Now we make six that are genuinely different.** The overlap's smaller, but the impact is bigger."
> "**Most brands keep changing how ads look but not what they say.** You unlock new pockets of audience only when you actually change the story you're telling."

### 10.2 The test order to encode

| Priority | Layer varied | Why it comes first | Expected effect size |
|---|---|---|---|
| **1** | **Offer** | Cheapest to change (no asset regeneration), largest swing. "What wins BFCM is offers, not creative." — Jess Bachman, FireTeam | Largest |
| **2** | **Messaging angle** (pain x persona intersection) | Changes *what you say*; the only layer that "unlocks new pockets of audience" | Large |
| **3** | **Awareness stage** | Same angle, different funnel position; multiplies one angle into 5 distinct ads | Large |
| **4** | **Creative mechanic** | How the viewer arrives at the truth | Medium |
| **5** | **Hook tactic + trigger** | The first 1–3 s frame | Medium |
| **6** | **Visual format** | The production vessel | Medium |
| **7** | **Asset type / production tier** | Medium and cost | Medium |
| **8** | **Minor variations** (colour, music, cut timing, CTA button) | Cheapest, smallest, **and now algorithmically penalised** — see §11.3 | Smallest |

**Why offer is #1 and often missed by creative-centric systems.** The genome must treat `offer_type` and `offer_value` as *variables to optimise*, not as fixed campaign inputs. Motion publishes a whole article on offer comparison (<https://motionapp.com/blog/comparing-how-different-offers-perform>) and `offer_type` is one of the seven AI Tagging dimensions. The 2026 hook leaderboard is dominated by offer-carrying tactics precisely because the offer is doing the work.

### 10.3 The many-to-many matrix that generates the test space

From the Creative Strategy Engine — this is the combinatorial structure your planner should build:

```
Pain/Desire Buckets
  x Personas per bucket           (3-5 per pain, per the framework)
  x Messaging Angles              (one per pain x persona intersection)
  x Awareness Stages              (5)
  x Hooks per stage               ("3-5 hooks per messaging angle per awareness stage")
  x Visual Formats                (113, filtered by stage fit)
```

The stated relationships:
- **One pain → multiple personas.** "Cystic acne → Busy Professional, Stay-at-Home Mom, Bride. Each experiences the SAME pain but in different life contexts."
- **One persona → multiple pains.** "Busy Professional → Cystic acne, Chronic fatigue, Poor sleep quality."
- "**Each ✓ is a unique messaging angle opportunity.**"

### 10.4 What a messaging angle *is* (so you can validate generated ones)

> "A messaging angle is the core truth for a specific pain/desire x persona intersection… It's a conversational, human statement… **Not marketing copy. Not a tagline. Not a slogan.** Real language that a real person would say or think."

Published examples — note how short and how un-branded they are:

| Pain/Desire | Persona | Messaging Angle |
|---|---|---|
| Bulky Wallet | Minimalist professional | "Your wallet sucks" |
| Grout Stains | Homeowner who's tried everything | "You shouldn't need a power washer for your bathroom" |
| Bored Cat (destructive) | Cat owner with shredded furniture | "Your cat isn't broken, they're bored" |
| Poor Sleep | Exhausted professional | "Melatonin stopped working three months ago" |
| Bland Meal Prep | Health-conscious but busy | "Healthy eating shouldn't taste like punishment" |

And the explicit bad/good contrast:

> **Bad (corporate/stuffy):** "Professional-grade natural healing without prescription side effects"
> **Good (conversational/human):** "Your dermatologist wrecked your skin"

**Validators you can run on a generated angle:** <=10 words; contains no brand name; contains no product-category noun where avoidable; passes the Out-Loud Test; is a *claim about the reader's world*, not about the product.

The four questions that define an angle (structured generation prompt):
1. **Use Case** — how exactly does *this* person experience *this* pain?
2. **Deepest Desire** — what do they *really* want, beyond surface wants?
3. **Feature/Benefit Priorities** — feature = fact about the product; benefit = how *this person* experiences it. "Different personas care about different features AND experience the same features as different benefits."
4. **Top Objections** — what would *they specifically* doubt?

**Anti-pattern the framework names explicitly:** demographic-only targeting as a substitute for a pain. *"'Hey, are you a busy mom? You should get this water bottle.' → Being a mom doesn't tell me WHY I need this water bottle."* The fix is `pain + demographic`, never demographic alone.

---

## 11. Creative fatigue, decay, and refresh cadence

### 11.1 The detection thresholds

From <https://motionapp.com/library/glossary/creative-fatigue> and <https://motionapp.com/library/glossary/frequency> **[VENDOR-CANON]**:

**Definition:** *"Creative fatigue happens when you've shown the same creative to the same audience too many times. Frequency climbs, CTR drops, conversion rate falls… Essentially, Meta is running out of people to convert with this ad, and/or your target audience is getting sick of seeing the same ad."*

**Warning signs (encode as an alert rule with AND/OR structure):**
- **Frequency above 4–5** (the frequency glossary entry uses the slightly tighter *"above 3–4 often signals you're showing the same ad to the same people too many times"*)
- **CTR declining 30%+ week-over-week**
- **CPM increasing while reach plateaus**
- **ROAS or CPA deteriorating despite consistent budget**
- Plus creative-level signals from <https://motionapp.com/blog/ad-fatigue>: dropping thumbstop ratio, negative comments, engagement drop-offs mid-video

`Frequency = Total Impressions / Total Reach`.

> **Gotcha — this is the one that will actually break your fatigue detector.** `frequency` in the Insights API is **window-scoped**: it equals impressions / reach *for the queried window only*. Daily frequency values **cannot be averaged** into a weekly frequency, and `reach` must never be summed across days or breakdown rows. See `meta-insights-measurement.md` §Gotchas 4–5. Issue a separate query per window you want a frequency for.

> **Second gotcha.** The `frequency_value` **breakdown** has a **6-month retention cap** (since 2026-01-12) and, since **2026-08-06**, **requires manual Ads Manager opt-in** for certain accounts — requests return *no results*, not an error. See `meta-insights-measurement.md` §3.4 and Gotcha 17. Motion's glossary also states *"Meta is phasing out unique metrics like frequency, reach, and unique clicks."* **Design the fatigue detector to work without `frequency_value` and to degrade gracefully to a CTR/CPM/hook-rate trend model.** Do not build a fatigue system whose primary signal is a metric you cannot self-serve.

### 11.2 The differential-decay rule — what to refresh first

From <https://motionapp.com/blog/ad-fatigue>: *"not all creative components fatigue at the same rate."*

| Component | Fatigue rate | Refresh priority |
|---|---|---|
| **Hook** | Fastest — "Hooks fatigue fastest because of pure frequency" | 1 — refresh first, alone |
| **Visuals** (imagery, video style, graphics) | Medium — "need periodic tweaks" | 2 |
| **CTA** | Slowest — "fatigue more slowly, needing fewer updates" | 3 |

**Encode as a fatigue-response ladder:** on first fatigue signal, regenerate **only the first 1–3 seconds** and relaunch as a new ad, holding body/offer/copy constant. This is the cheapest possible intervention and the one the data says targets the fastest-decaying component. Only escalate to full-concept replacement if hook-swap fails.

Rotation cadence by platform (stated, **[PRACTITIONER]**):
- **Facebook/Instagram: 2–4 week rotation cycles** — "Bigger audiences or platforms like Facebook support longer rotation cycles"
- **TikTok: weekly or daily** — "fatigue can strike swiftly, with engagement metrics dying overnight"
- Smaller/niche audiences need more frequent rotation; wider audiences tolerate longer
- Conversion/DR objectives need shorter cycles than awareness

**Do not rotate everything at once:** *"Instead of switching every creative at once, you should think about tweaking — introduce new variants gradually or in small groups."*

### 11.3 Andromeda — the 2026 change that specifically penalises minor variation

This is the most build-relevant recent platform change for a *generative* system, and it is genuinely contested, so here is both sides.

**What it is claimed to be** (<https://motionapp.com/blog/andromeda-impact-on-bfcm>): a change in how Meta **retrieves and groups** ads. *"It's reshuffled how Meta retrieves and groups ads, rewarding true creative diversity and collapsing duplicates. **Five product shots with slightly different copy variations? Meta sees that as one ad now.**"*

**The sceptics [PRACTITIONER]:**
- Jess Bachman (Creative Strategy Director, FireTeam): *"What are we doing about Andromeda for BFCM? **Absolutely nothing.** Your top BFCM ads will be evergreen… What wins BFCM is **offers, not creative**."*
- Aazar Ali Shad (Founder, The Performers; manages **>$7M/month** in spend) called it *"nothing more than a snake oil scheme"* on LinkedIn — *"Maybe it'll start to matter in a few months. But I don't see it in action yet."*

**The adopters [PRACTITIONER]:**
- Lee Joselowitz (The Quality Edit): shifted budget from promo-versioning best performers to *"net-new creative testing and bigger swings — especially in the visual hook."*
- Joannah Wallace (VP Paid Creative, Birddogs): *"We're thinking less about discounts and more about **personas**. The more our ads speak to different kinds of shoppers, the better Andromeda performs."*
- Connor Rolain (HexClad): 75 ads/campaign → **6 genuinely different ones**.
- Dara Denney: *"sure, make sure you have visual diversity and focus less on variations. But **I'm capping my teams at two [variations]**."*

**Two numeric claims attributed to Meta's own data**, relayed by Marin Istvanic and reported in that article — **[FOLKLORE]** as cited (no primary Meta link given, and I could not reach a Meta source this session):
- *"creative already drove roughly **half of performance outcomes**"*
- *"after **four exposures** to the same ad, the chance of conversion drops by about **45 percent**"*

If the second figure is even directionally right, it independently justifies a frequency cap around 3–4 and matches the fatigue thresholds in §11.1 from a completely different direction. Treat as corroborating, not as fact.

**What to encode regardless of who is right about Andromeda.** The engineering decision is robust to the disagreement, because near-duplicate generation is *at best* neutral and *at worst* actively collapsed:

1. **Enforce a semantic-diversity floor on every launch batch.** Compute pairwise distance over the genome tuple `(messaging_angle, creative_mechanic, hook_tactic, visual_format, asset_type)` plus an embedding distance over the script and the first-frame image. Reject a batch whose median pairwise distance is below a threshold.
2. **Cap variants per concept at ~2** (Denney's number) rather than the 10–20 an automated generator will happily produce.
3. **Spend the freed capacity on angles and personas**, not on renders. This is the ordering in §10.2 restated as a budget rule.
4. This inverts the naive "AI lets us make 500 ads" pitch. **The winning move is not more ads; it is more genuinely different ads** — which is still a volume story (§1), just at the concept layer rather than the render layer.

### 11.4 The counter-argument: wear-in, not wear-out

Do not build a system that refreshes on a timer. <https://motionapp.com/blog/why-ads-resist-creative-fatigue> makes the opposing case and it is well-sourced:

- **Les Binet's "wear-in" effect:** *"good ads don't wear out, they wear in – getting more effective the more they're seen."*
- **Brand recall needs 5–7 impressions minimum** *"for a consumer to remember a message"* — and that's for recall, not conversion. *"Meta tries to keep frequency at a healthy level to avoid creative fatigue, so you likely need multiple creatives to get to seven impressions."*
- **System1 study:** *"The most consistent brands earn an average ROI of **8.8**, while the least consistent sit at **2.1**."* (~4x)
- The echo-chamber warning: *"by the time you're sick of your message, a potential buyer is hearing it for the first time."*

**Modular messaging** is the reconciliation: keep one core message, vary sub-messages that ladder to it. The worked example is The Ridge — core message "a better wallet," sub-messages: durability, size/slimness, modular design, RFID-blocking, lifetime warranty. Also Liquid Death ("Murder your thirst" in ~half their ads) and Geico ("15 minutes could save you 15%," 20+ years).

**The synthesised rule to encode — this resolves §11.1 vs §11.4:**

```
refresh_trigger = performance_decline_detected   # NOT elapsed_time
                  AND NOT iteration_space_exhausted_for_this_angle

# i.e. hold the messaging angle constant far longer than feels comfortable;
# vary hook / mechanic / format underneath it;
# only retire the angle when the whole sub-tree has been explored and decayed.
```

Stated directly by the source: *"Instead of refreshing creative when you're personally tired of it, refresh when performance metrics actually decline or when you've exhausted your testing iterations on a core message."*

**This is arguably the most important single rule for an autonomous system,** because an AI has no fatigue instinct at all and will happily either (a) never rotate, or (b) rotate on a cron. Both are wrong. Tie rotation to measured decline plus exhaustion of the angle's variant space.

---

## 12. Testing frameworks and what statistical rigor is actually achievable

### 12.1 The three-phase framework

From Ben&Vic (performance agency) via <https://motionapp.com/blog/ultimate-guide-creative-testing-2025> **[PRACTITIONER]**:

**Phase 1 — Which new creative is best?**
The framing error it corrects: *"The first mistake many advertisers make is testing new creatives against old ones right away. This creates an unfair comparison since older ads have accumulated historical data and pixel optimization that new ads don't have. Instead, **always test new creatives against other new creatives only**."*

| # | Structure | Accuracy | Cost-efficiency | Best for |
|---|---|---|---|---|
| 1 | ASC+ campaign with all creatives | * | *** | Smaller accounts; maximise efficiency, don't overcomplicate |
| 2 | CBO, each ad set = 1 creative | * | *** | Smaller accounts |
| 3 | **ABO, each ad set = 1 creative concept (+variants)** | ** | ** | Medium accounts; **"ABO will allow you to get quicker results than CBO"** |
| 4 | CBO, each ad set = 1 concept (+variants) | * | *** | Medium accounts. **"CBO might spend a big share of your budget on a specific ad set. I recommend using rules to turn off overspending ad sets (e.g., after 2 to 3 x the target CPA)."** |
| 5 | **ABO + cost cap**, 1 ad set per concept | *** | *** | Big accounts, **>$500K/month** |

**Phase 2 — Is the new creative better than the incumbent?**

| # | Structure | Accuracy | Cost-efficiency | Best for |
|---|---|---|---|---|
| 1 | CBO, 2 ad sets (old vs new), 1 creative each | * | *** | Limited budgets |
| 2 | ABO, 2 ad sets, 1 creative each (+variants) | ** | ** | Medium budgets |
| 3 | **1 ad set with 1 new + 1 old creative, cost cap** | *** | *** | Big accounts, >$500K/month |

**Phase 3 — Scale.** Four rules, all counterintuitive enough to be worth encoding:
- Begin scaling **immediately** on validation
- **Add the new creative to fatigued ad sets to refresh their performance** (rather than launching in isolation)
- **Do not pause old creatives** — keep them running alongside
- Be patient with CBO/ASC+ — they need time to adjust to new creatives

That third rule contradicts the instinct to prune, and it is consistent with §1.3's warning about deleting the mid-range ballast.

### 12.2 The statistical reality at small budgets

**The textbook standard** (<https://motionapp.com/library/glossary/statistical-significance>): *"Most statisticians require **95% confidence** and at least **100 conversions per variant** before calling a test conclusive."*

**Proper A/B test requirements** (<https://motionapp.com/library/glossary/a-b-test-split-test>): single variable changed; statistically significant sample size; **minimum 7 days**; even budget distribution; success metric defined upfront.

**Now do the arithmetic.** At a $40 CPA, 100 conversions per variant is **$4,000 per arm**. A two-arm test is $8,000. A micro-tier account (<$10K/month total) can run **roughly one properly-powered creative test per month**, while the same tier's benchmark testing volume is **2.3–2.8 creatives per week** (§1.2). These two facts are irreconcilable.

**Therefore: at micro and small tiers, classical significance testing on conversions is not achievable, and any system that claims it is, is lying.** What is achievable:

| Budget tier | Achievable rigor | Decision metric | Kill rule |
|---|---|---|---|
| **Micro (<$10K/mo)** | None on conversions. Directional only. | **Spend allocation itself** (does Meta give it budget?) + **hook rate** (needs only impressions, which are cheap) | Let the delivery system decide; kill on hook-rate z-score and on the 28-day boundary |
| **Small ($10K–$50K)** | Upper-funnel metrics are powered; conversions are not | Hook rate, hold rate, CTR (all impression-denominated → thousands of samples per day) | Sequential/bandit on upper-funnel; 28-day boundary for the spend classification |
| **Medium ($50K–$200K)** | Conversion tests powered for large effects only | CPA/ROAS with wide intervals; still lean on upper-funnel for fast signal | 2–3x target CPA rule (Scenario 4 above) |
| **Large / Enterprise** | Classical A/B viable; cost cap gives clean comparison | CPA/ROAS | Cost-cap-mediated |

**This is the key design insight for the small-budget case, and it is the reason the benchmark report's methodology is a gift:** the report deliberately uses **realized spend** as its success metric precisely because it "allows consistent cross-account comparison." **Meta's own delivery system is a far better-powered evaluator than your statistics are.** It sees every impression and reallocates continuously. A small-budget system should therefore:

1. Launch into a structure that lets Meta allocate (ASC+ or CBO — Scenarios 1 and 2, explicitly recommended for smaller accounts).
2. Read **`spend` relative to account median** as the primary early signal — this *is* the winner definition.
3. Use **impression-denominated metrics (hook rate, hold rate, CTR)** for fast creative diagnosis, because they reach useful sample sizes in hours, not weeks.
4. Reserve conversion-based inference for **pooled, cross-account, attribute-level** estimation (§4.6), where the whole platform's data is the sample — not for the single-account A/B decision.

That fourth point is the platform's structural advantage over any single advertiser and should be the centre of the product story.

### 12.3 Minimum viable test budget

The only concrete published number found, for hook testing specifically (<https://motionapp.com/thumbstop-guide/how-to-stop-a-scroll-in-3-seconds>) **[PRACTITIONER]**:

> "At the very least, you need a **$100 budget in a three-day minimum window for each thumbstop**. This budget is important because an ad needs enough impressions, clicks, and days spent to paint an accurate portrait."

Combined with the A/B minimum of 7 days, encode:

```
MIN_TEST_BUDGET_PER_HOOK_USD   = 100
MIN_TEST_WINDOW_DAYS_HOOK      = 3
MIN_TEST_WINDOW_DAYS_AB        = 7
CLASSIFICATION_WINDOW_DAYS     = 28   # winner/mid-range/loser boundary
CBO_RUNAWAY_ADSET_KILL         = 2.5 * target_cpa   # "2 to 3 x the target CPA"
```

### 12.4 The iron law, and how to sequence around it

> "Each iteration should be tackled in a **single test to isolate the variables** and build progressive learnings on my brand and audience."

But the same guide gives a **two-stage** procedure that resolves the tension between the iron law and the need to explore fast:

**Stage A — divergent.** *"If you are creating a thumbstop for the first time you'll want to create **three very different versions** to get a higher-level understanding of what is working and what isn't."* Worked example for a tire-rim cleaner:
1. Wipe cloth against a **dirty** rim (show the problem)
2. Wipe cloth against a **clean** rim (show the result)
3. Drive up to a date, zoom in on gross rims (show the social stakes)

**Stage B — convergent.** Once a winner emerges, vary **one thing at a time**: studio vs UGC imagery; the bold problem statement; the material used to wipe.

**This maps exactly onto explore/exploit and is the right loop for an autonomous system.** Stage A varies the *messaging angle / mechanic* (high-level, multi-variable, deliberately confounded, cheap information about a big space). Stage B varies *one genome field* (clean attribution, feeds the regression in §4.6). Do not run Stage B before Stage A has picked a region — you will spend your whole budget optimising a losing angle.

### 12.5 Naming conventions are load-bearing infrastructure

Motion sells a feature for it (<https://help.motionapp.com/en/articles/10024185-streamline-and-automate-your-motion-reports-with-naming-conventions>): *"automatically group ads in Comparative Reports based on variables like hooks, creators, format, and more."*

For a system that controls both generation and publishing, this is trivially solved and should be non-negotiable: **encode the full genome tuple into the ad name at creation time**, so that (a) any third-party analytics tool can group by it, (b) a human auditing in Ads Manager can read it, and (c) you can recover attribution even if your own DB is lost.

```
{angle_id}|{stage}|{mechanic}|{hook_tactic}|{trigger}|{format}|{asset_type}|{offer}|{variant_n}|{yyyymmdd}
```

Check the length against the ad `name` limit before adopting a long scheme — **[UNVERIFIED]** what the current cap is; verify against `meta-campaign-publishing.md`.

### 12.6 Production-system reference (what "high volume" actually looks like)

Useful as a target architecture and as a source of QA checklists. Savannah Sanchez ships **200+ ads/week for 50+ clients** with a three-role split and a fixed weekly cadence (<https://motionapp.com/blog/how-to-build-a-high-volume-ad-production-system-for-meta-and-tiktok-in-2026>) **[PRACTITIONER]**:

| Role | Job | Automation analogue |
|---|---|---|
| **Strategist** | Analyses performance data to find winning patterns; competitor/trend research; reviews all footage; owns the ad end-to-end | The genome regression + planner |
| **Creator** | Raw content only, **no editing**. "You're not paying the creator to be the creative strategist." | The generation model |
| **Editor** (10 in parallel) | Assembly from detailed briefs | The render/compositing pipeline |

Weekly cadence: **Mon–Tue film** (40 internal creators, iPhone, specified lighting/setting) → **Wed–Thu edit** (10 editors, 4–12 ads per client) → **Fri deliver**.

**The 6-point creator brief checklist — this is directly a generation-prompt schema:**
1. **Product focus** — which features to highlight and how to use them correctly
2. **Visual examples** — links to **3–5** reference ads showing shot type, transitions, energy level
3. **Detailed shot list** — bullet per shot ("Show yourself swiping through outfit options"; "Looking distressed before, then happy after")
4. **Hook variations** — **multiple script options for the opening 3 seconds, with instructions to record each version**
5. **Script body** — exact messaging for middle and end
6. **Content guide** — brand values, dos and don'ts, inspiration

Note point 4: **hooks are shot as a batch against one body.** That is exactly the differential-decay strategy in §11.2 implemented at production time, and it is trivially cheap for a generative pipeline — render one body, N hooks.

**Editor brief (4 items):** edit inspiration links with comments explaining *why* elements worked; cleaned voiceover file; **line-by-line caption instructions**; visual direction per line. *"If you just hand them a disorganized Dropbox with no captions, it's going to take them so much longer."*

**Footage QA checklist (pre-edit):** clips follow the inspiration examples; **HDR turned off** (prevents saturation issues in post); clean audio (no fans, AC, construction); delivery doesn't sound like reading from a script.

**Final QA checklist (pre-delivery):** correct length; format makes sense (or intentionally breaks format); **watch with sound off at least once** to catch spelling errors missed when hearing the voiceover.

The HDR note is the kind of detail that costs a day: **HDR-captured source produces oversaturated output after editing.** If your pipeline ingests any real footage, normalise colour space on ingest.

---

## 13. Vertical differences

### 13.1 Testing volume by vertical x tier

Source: <https://motionapp.com/library/research/creative-benchmarks-2026/testing-by-vertical>. Median creatives launched per week per account. **[DATASET]** (illustrative sample; full heatmap is in the PDF, not the LLM package)

| Vertical | Micro | Small | Medium | Large | Enterprise |
|---|---|---|---|---|---|
| Health & Wellness | 3 | 4 | 11 | 19 | **46** |
| Fashion & Apparel | 3 | 5 | 12 | 18 | 33 |
| Beauty & Personal Care | 3 | 4 | 8 | 15 | 26 |
| "Other" | 2 | 3 | 8 | 14 | 14 |

The 16 verticals in the dataset: Health & Wellness, Finance, Education, Beauty & Personal Care, Home & Lifestyle, Automotive, Professional Services, Technology, Fitness & Sports, Fashion & Apparel, Food & Nutrition, Entertainment & Media, Travel & Hospitality, Parenting & Family, Pets, Other.

**Three volume bands at Enterprise scale:**

| Band | Verticals | Creatives/week |
|---|---|---|
| High | Health & Wellness, Fashion & Apparel, Beauty & Personal Care | **25–46** |
| Medium | Home & Lifestyle, Food & Nutrition, Technology, Pets | 15–25 |
| Low | Automotive, Finance, Travel & Hospitality, Professional Services | **10–16** |

Stated drivers: product-cycle length ("Fashion drops every few weeks; cars launch every few years"); creative conventions ("Finance ads face regulatory and tone constraints that make rapid iteration harder"); audience fatigue tolerance; production economics.

**Benchmarking rule, stated explicitly:** *"If your vertical's Medium average is materially higher (like Fashion's ~12), that's the benchmark you should be comparing to — not the all-vertical average [6.6]."* **Encode volume targets as a `vertical x tier` lookup, defaulting to the tier median only when the vertical is unknown.**

### 13.2 Format performance inverts across verticals

Source: <https://motionapp.com/library/research/creative-benchmarks-2026/visual-formats-by-vertical>. This is the finding that most strongly argues against a single global creative policy.

**Health & Wellness** — "trust, credibility, and personal narrative dominate":
- By hit rate: `Stitch` · `Reaction video` · `Unboxing` · `Celebrity` · `Founder` · `Letter` · `Stop motion` · `Influencer endorsement` · `POV` · `Transformation`
- By SUR: `Social post mockup` · `Letter` · `Celebrity` · `Case study` · `Offer-first banner` · `Behind the scene` · `UGC overlay` · `Founder` · `Transformation` · `Billboard`

**Fashion & Apparel** — "aesthetic, discovery, and cultural-fluency formats lead":
- By hit rate: `Post-it` · `Quiz` · `Stylized product shot` · `Meme` · `ASMR` · `Product shot` · `Social comment` · `Podcast` · `Product showcase` · `Unconventional text placement`
- By SUR: `Podcast` · `Unconventional text placement` · `Billboard` · `Text message` · `Sign` · `Celebrity` · `Slideshow` · `Post-it` · `Offer-first banner` · `Demo`

> "The top-10 format lists by hit rate have **almost no overlap** between Health & Wellness and Fashion & Apparel. **Founder** (top 5 in Health & Wellness) doesn't appear in Fashion's top 10. **Post-It and Meme** (top 5 in Fashion) don't appear in Health & Wellness's top 10."

Three stated mechanisms: **audience context** (H&W buyers evaluate whether to *trust a claim*; Fashion buyers evaluate whether something *fits their taste*); **consideration cycle** (H&W longer/research-driven → Case Study, Letter, Expert Explainer; Fashion shorter/impulsive → Meme, Post-It); **production conventions** ("A Founder ad is normal in Health & Wellness; it feels awkward in Fashion. A Meme is normal in Fashion; it feels off-brand in Finance.").

**Encode as a per-vertical format prior, and warn explicitly against cross-vertical transfer:** *"A format that's working for a Fashion brand is a **hypothesis** — not a prescription — for a Health & Wellness brand. The audience context is different enough that **performance can invert**."*

### 13.3 Non-ecommerce verticals — thinner evidence, stated honestly

The 2026 dataset's vertical taxonomy is ecommerce/DTC-shaped. Coverage for the other business models the platform must serve:

| Vertical | What the sources support | Confidence |
|---|---|---|
| **Ecommerce / DTC** | Everything above. This is where the data is. | **[DATASET]** |
| **Lead-gen / local services** | Legacy CTR table puts legal at 1.61% (highest of the listed set); Foreplay maintains vertical example collections for chiropractor, dental, insurance, financial advisor, real estate (`foreplay.co/post/*-facebook-ad-examples`). The `Professional Services` vertical is in the dataset and sits in the **low** volume band (10–16/wk at Enterprise). Motion's `Problem Agitation` format page includes a Fiverr (Professional Services) example decomposed in full. | **[PRACTITIONER]** / thin |
| **App installs** | `Mobile Apps & Gaming` is one of Foreplay's six named solution segments; `foreplay.co/post/facebook-app-install-ad-examples` exists. Relevant formats from the taxonomy: `App Mockup`, `UI Mockup`, `Screen Recording`, `Gamification`, `Warning Screen`, and the ~18 interface-mockup formats generally. | **[UNVERIFIED]** — no quantitative benchmarks located |
| **Info products / education** | `Education` is in the dataset (low-to-mid volume band). `VSL` / `Video Sales Letter` is a first-class format and is the canonical info-product vehicle. Hook tactics `Authority`, `Contrarian`, `Myth Busting`, `Belief`, `Reasons Why` map to the sophisticated-audience conditions in §6.1. Motion's `Problem Agitation` brand list includes Mindvalley (230 ads, Education). | **[VENDOR-CANON]** / inferred |
| **B2B SaaS** | `Technology` is in the dataset (medium volume band, 15–25/wk at Enterprise) and is named among verticals where "high production is table stakes rather than differentiator." Foreplay maintains `best-saas-ads` and `b2b-facebook-ad-examples` collections and has a `B2B & SaaS` solution segment. Motion has a LinkedIn integration "to create Top Performing reports for your B2B campaigns." | **[PRACTITIONER]** / thin |

**Honest statement for the build:** the creative-genome priors in this document are **well-evidenced for DTC ecommerce and weakly evidenced everywhere else.** Do not ship global priors derived from §5.5/§6.2 into a lead-gen or B2B account. Cold-start those verticals from a **uniform prior over the eligible format set** (filtered by §5.3 funnel fit and §6.1 tactic conditions) and let the account's own data dominate quickly.

### 13.4 Vertical-driven metric selection

From <https://motionapp.com/blog/key-creative-performance-metrics>: *"Ecommerce clients care about ROAS and CPA. Lead generation clients care about cost per lead and **lead quality**. Brand awareness campaigns might prioritize reach and engagement."*

**"Lead quality" is the trap for an autonomous lead-gen system.** Optimising to `cost_per_lead` with a creative generator in the loop will reliably discover that vague, over-promising hooks produce cheap junk leads — the §3.4 clickbait failure mode transposed one funnel stage down. Lead-gen accounts **must** wire a downstream qualification signal (CRM stage, call-connect, qualified-lead event) back into the genome outcome before the loop is allowed to run unattended.

---

## 14. Competitive intelligence as a genome input

An autonomous system can do something a human strategist cannot: continuously mine the public ad libraries for genome values that are *already proven*, and use them as priors.

### 14.1 Days-running is the public performance proxy

The mechanism, from <https://www.foreplay.co/post/ad-library-mcp> **[VENDOR-CANON]**:

> "Anyone can launch 20 ads in a week — that doesn't mean any of them work. But **an ad that's been running for months is a strong signal that the brand found something profitable worth keeping live.**"

And the worked example from <https://www.foreplay.co/post/how-to-analyze-top-performing-hooks>: a skincare brand's top hook had been running **~1,000 days**; another for 500 days. Sorting a competitor's ads by `longest_running AND active` surfaces their proven creative.

**This is directly analogous to the benchmark report's own definitions** — mid-range is `>=28 days of spend`, and the winner definition is spend-based. Days-running is the *publicly observable* shadow of the same quantity. **Encode `competitor_ad.days_running` as a prior weight on genome values.**

### 14.2 Machine access

| Access path | Detail |
|---|---|
| **Foreplay MCP server** | `https://public.api.foreplay.co/mcp` — `claude mcp add --transport http foreplay https://public.api.foreplay.co/mcp`. Per-ad fields: the creative (video/image), ad copy, CTA, landing page URL, active/inactive status, **how long it has been running**. Coverage claimed: Facebook, Instagram, TikTok, YouTube, LinkedIn. Access follows the user's Foreplay plan. |
| **Foreplay REST API** | Exists (<https://www.foreplay.co/post/api-launch>); not examined this session — **[UNVERIFIED]** for schema/limits |
| **Meta Ad Library API** | First-party; not covered here — see `meta-api-foundations.md` |

> **Coverage-number discrepancy, flag it:** the MCP article claims *"200M+ ads"* and *"200,000,000 ads"*, while the site's own live footer counter on the same domain reads **54,683,980** total (1,835,779 live / 52,848,201 historical) and the product nav says *"Ad search engine with over 100M ads."* Three different numbers on one site. **Do not quote any of them as a fact**; treat coverage as "tens of millions, unverified."

### 14.3 The whitespace query — the genuinely novel automated capability

The stated agency use case is the one worth building:

> "From there you can ask it to surface **whitespace** — maybe every competitor uses founder-led video but nobody uses customer proof, or everyone pushes a discount but nobody sells speed."

Formalised against the genome: build the competitor genome distribution over `(hook_tactic, visual_format, messaging_angle_cluster, offer_type)`, then rank candidate cells by `expected_value(cell) / competitor_density(cell)`. High-value, low-density cells are the test queue. **This is a mechanical operation on a tagged corpus and it is exactly the kind of thing a human strategist does badly and slowly.**

---

## 15. Gotchas

1. **Hold rate has two incompatible published formulas on the same vendor's site** (15-sec-plays-based vs ThruPlay-based). Version A silently reports 0% for every video under 15 s — i.e. most Reels creative. Pick the ThruPlay version and store the definition with the value. (§3.1)

2. **Meta's advertiser-facing creative guidance is not machine-readable.** `facebook.com/business/help/*`, `/business/ads-guide/*` and `transparency.meta.com/*` return HTTP 400 with body `Error` to `curl`, and only a `<title>` to a rendering fetcher. You cannot ingest Meta's own creative specs programmatically. Pin them from `meta-video-creative.md` §9 and re-verify by hand on a cadence. (§0.3)

3. **`frequency` is window-scoped and cannot be averaged.** Daily frequencies do not aggregate into a weekly frequency; `reach` must never be summed across days or breakdown rows. A fatigue detector that averages daily frequency will report nonsense. (§11.1)

4. **`frequency_value` breakdown: 6-month retention cap, and manual Ads Manager opt-in required for certain accounts since 2026-08-06.** Requests return *no results*, **not an error** — so a naive integration reports "no fatigue" rather than failing loudly. Build the detector to work without it.

5. **Character limits are display-truncation limits, not API limits.** `asset_feed_spec` bodies accept 1024 chars; the ad renders ~40. Nothing errors — your copy is just never read. Generate to the *minimum across the placement set*, or use per-placement `body_label`/`title_label`. (§9.1)

6. **At 40 characters of primary text, the hook cannot live in the caption.** It must be a burned-in first-frame overlay plus the visual. Any generator that puts the hook in `message` has shipped a hookless ad on Reels. (§9.1)

7. **Advantage+ Creative will add its own AI generation on top of yours unless opted out** — `music_generation`, `image_background_gen`, `translate_voiceover`, `creative_stickers`. An ad can ship with a Meta-generated voiceover translation over your tested hook, invalidating the test. Disable `degrees_of_freedom_spec` on any creative whose first 3 seconds are the variable under test. (§8.4)

8. **Meta places the AI label *next to "Sponsored"* — not behind the three-dot menu — when the creative contains photorealistic AI humans.** Automated third-party-AI detection has been live since 2026-06-01. Any AI-UGC strategy premised on the viewer not noticing is already broken on Meta. (§8.4)

9. **An AI-generated person saying "this product changed my life" is a fabricated consumer testimonial under the FTC Reviews & Testimonials Rule, which carries civil penalties. Meta approving the ad is not a defence.** Synthetic presenters must be framed as narrators/spokespeople, never as customers reporting personal results. (§8.4)

10. **Raw AI-avatar output is not shippable.** The documented working practice is to interleave b-roll and product shots so the synthetic presenter never holds frame for long. Uncanny-valley artefacts accumulate with contiguous duration. (§8.4)

11. **Optimising hit rate teaches the system to stop testing.** Two accounts with identical hit rates can differ 10x in winners produced. Always co-report volume; never make hit rate an objective. (§1.3)

12. **A naive "pause anything under target ROAS" rule deletes the mid-range ballast** — 38–46% of creatives and 22–46% of spend, which the data describes as what "keeps performance steady while new ideas compete for spend." (§1.3)

13. **Optimising a weighted sum of creative metrics will discover clickbait.** Use hard constraints on hook rate / hold rate / CTR / CVR, not weights. This is the most likely way an autonomous creative loop silently destroys an account. (§3.4)

14. **In lead-gen, optimising `cost_per_lead` produces cheap junk leads** — the same failure one stage down. Wire a downstream qualification signal into the outcome before running unattended. (§13.4)

15. **Every leaderboard in the 2026 dataset is BFCM-contaminated** (window: Sep 2025 – Jan 2026). Offer-First Banner, Newness, Sale Announcement, Price Anchor and Urgency are all seasonally inflated; the source says so itself. Do not make Offer-First Banner the March default. (§4.6)

16. **The Large-tier spend-allocation row is reconstructed, not observed.** `SOURCE_MAP.md` documents that the OCR gave a different column order and the publisher reordered it for narrative monotonicity. (§1.1)

17. **Motion's AI Tagging article says "8 categories" but enumerates 7.** Do not assume you know the eighth. (§4.2)

18. **`Video Sales Letter` and `VSL` are both present as separate format slugs.** Probable duplicate; dedupe before using the enum. (§5.2)

19. **Foreplay publishes three mutually inconsistent ad-library size figures** (54.7M footer counter, "over 100M" nav, "200M+" article) across one domain. Don't quote any of them. (§14.2)

20. **The industry CTR benchmark table (0.90% all-industry, legal 1.61%, etc.) has no stated date or sample** and matches a long-circulating legacy dataset. Do not seed a model with it. (§3.2)

21. **"Facebook recommends 5–15 second video ads" is unsourced and contradicts the decomposed winning DR ads** (47 s, 52 s) and the taxonomy's own long-form `VSL` format. Duration is a per-format parameter, not a global constant. (§5.6)

22. **Under Andromeda, minor variants may be collapsed as duplicates** — "five product shots with slightly different copy variations… Meta sees that as one ad now." The claim is contested by operators spending >$7M/month, but generating 20 near-identical variants is at best neutral and at worst wasted. Cap variants per concept at ~2 and spend the capacity on angles. (§11.3)

23. **Do not rotate creative on a timer.** Les Binet's wear-in effect, a 5–7 impression recall floor, and System1's 8.8-vs-2.1 consistency finding all argue that timer-based refresh destroys value. Rotate on measured decline *and* exhaustion of the angle's variant space. (§11.4)

24. **Never test new creative against incumbents in the same ad set at launch** — incumbents carry historical delivery and pixel optimisation. New-vs-new first (Phase 1), then new-vs-champion (Phase 2). (§12.1)

25. **CBO will dump budget into one ad set and starve the test.** Use rules to pause ad sets that overspend at 2–3x target CPA, or use ABO/cost-cap for accuracy. (§12.1)

26. **Classical significance is unreachable below roughly $50K/month.** 100 conversions/variant at a $40 CPA is $4,000 per arm; the same tier's benchmark cadence is 2.3–2.8 creatives/week. Use impression-denominated metrics for creative decisions and pooled cross-account estimation for attribute-level inference. (§12.2)

27. **Cross-vertical format transfer inverts.** Founder is top-5 in Health & Wellness and absent from Fashion's top 10; Post-It and Meme are the reverse. A global format prior will actively mislead in a vertical it wasn't fitted on. (§13.2)

28. **Price precision is an authenticity tell in UGC scripts.** "$42.99" reads as scripted; "like $40-something" reads as human. Apply a rounding/hedging transform to numerals in UGC copy. (§9.2)

29. **If the hook's meaning depends on audio in the first 3 seconds, it is a defect.** Sound-off is the default viewing mode; that is why the "bold problem statement" is a text overlay. QA every generated ad muted. (§3.5)

30. **The 35% bottom safe-zone margin is where the CTA sheet and Reels action rail sit.** Text placed there is covered. Use the stricter set (14% top / 35% bottom / 6% sides) — see `meta-video-creative.md` §9.1. (§3.5)

31. **HDR-captured source footage oversaturates after editing.** Turn HDR off at capture, or normalise colour space on ingest. From a 200-ads/week shop's footage QA checklist. (§12.6)

---

## 16. Open questions / unverified

1. **Meta's own published creative guidance could not be read.** All of `facebook.com/business/help/*`, `/business/ads-guide/*`, and `transparency.meta.com/*` are client-rendered and blocked to both `curl` and a rendering fetcher. Everything attributed to "Meta recommends" in this document is therefore **second-hand**. A human should open these pages and transcribe: the creative-best-practices articles, the text-in-ads guidance, and the CTA-by-objective matrix.

2. **General web search was unavailable this session** (§0.3). Under-covered as a direct result: peer-reviewed attention/advertising research; Meta's Foundational Ad Studies / Marketing Science publications; quantitative AI-UGC A/B evidence; emoji-lift studies; app-install and B2B benchmark sets.

3. **The exact Insights API field that yields "3-second video plays."** `video_play_actions` is the practitioner assumption but I could not confirm from v26.0 docs that it is strictly a 3-second threshold. Also unconfirmed: whether `video_thruplay_watched_actions` is still in the v26.0 doc field table (it is in the SDK — see `meta-insights-measurement.md` §16). **Verify both against a live account before building the hook-rate pipeline.**

4. **Whether hook rate and hold rate causally improve delivery efficiency** (lower CPM / cheaper CPA), as multiple practitioner sources assert. No Meta primary source located. Plausible; unproven.

5. **The two Meta-attributed numbers relayed via Marin Istvanic** — "creative drove roughly half of performance outcomes" and "after four exposures, conversion probability drops ~45%" — have no primary link. If real, the second is a direct input to the frequency cap.

6. **The Nielsen "creativity drives 56% of ROI" and Martech "CTR influences 4% of ROI" figures.** Both cited without links. The direction is consistent everywhere; the magnitudes are unverified.

7. **The eighth Motion AI Tagging category.** Article claims 8, enumerates 7.

8. **Full per-vertical format leaderboards.** Only Health & Wellness and Fashion & Apparel are published in the LLM package and the library pages; the other 14 verticals are in PDF pages 15–20, and the PDF itself was not reachable (`runt-media.motionapp.com/files/*.pdf` → 404 for every guessed filename; no `.pdf` link appears in the page HTML).

9. **The full CH-007 vertical x tier heatmap.** The LLM appendix publishes only 4 of 16 vertical rows and states "Exact cell values not fully reconstructed here from PDF OCR."

10. **The full CH-009/011/012 leaderboards with per-row hit rates and SURs.** Only 5 format rows carry full numbers; hooks and asset types are published as rank orders with banded ranges only.

11. **The `Video Sales Letter` vs `VSL` duplication** in the 113-format taxonomy.

12. **`max_contiguous_avatar_seconds`** for AI-UGC before uncanny-valley failure. The *structure* (interleave b-roll) is documented; the number (~3–5 s) is my inference.

13. **The Meta ad `name` field character limit**, needed to validate the naming-convention scheme in §12.5.

14. **Foreplay's REST API and MCP tool schemas** (tool names, parameters, rate limits, pricing). Only the server URL and the per-ad field list were confirmed.

15. **The other creative-analytics vendors** named in Foreplay's own comparison nav — Atria, Superads, Magic Brief, Adnova, Gethookd, AdsLibrary.ai, Adscan, SwipeKit. Not examined. `atria.com` and `triplewhale.com` both returned HTTP 403 to automated requests. Worth a manual pass, particularly Atria (positioned as a creative-intelligence competitor to Motion).

16. **Whether Andromeda actually collapses near-duplicate ads**, and if so at what similarity threshold. No Meta primary source; operator opinion ranges from "snake oil" (>$7M/month spender) to "changed our whole process" (HexClad). The engineering response in §11.3 is deliberately robust to the answer.

17. **Quantitative emoji effects in Meta DR copy.** Only qualitative guidance located (none in caption line 1).

18. **Music/audio as a genome dimension.** `music_type` is in the schema at §4.5 but no performance evidence was found for it. Note the constraint from `meta-video-creative.md` §13.4: Instagram will not promote Reels using copyrighted music.

---

## 17. Source index

**Primary dataset**
- Creative Benchmarks 2026 (report): <https://motionapp.com/thumbstop-pulse/creative-benchmarks-2026>
- **LLM data package (canonical, machine-readable):** <https://runt-media.motionapp.com/files/2026-motion-creative-benchmarks-report-llm.zip> — `LLM_REPORT.md`, `LLM_DATA_APPENDIX.md`, `SOURCE_MAP.md`, `CHART_SPECS.json`
- Key benchmarks summary: <https://motionapp.com/thumbstop-pulse/cb2026-key-benchmarks-and-insights>
- Per-finding pages: <https://motionapp.com/library/research/creative-benchmarks-2026/> — `top-visual-formats`, `top-hook-tactics`, `top-asset-types`, `testing-by-vertical`, `visual-formats-by-vertical`, `10x-benchmark`, `hit-rate-context`, `methodology`, `portfolio-breakdown-by-tier`, `spend-allocation-by-tier`, `spend-concentration`, `scale-and-volume`, `top-25-percent`, `testing-volume-by-tier`, `trends-are-not-universal`, `volume-vs-winners`, `winners-are-rare`, `spend-per-ad-distribution`

**Taxonomies and frameworks (Motion Creative Strategy Library — explicitly published for LLM citation; index at <https://motionapp.com/llms.txt>)**
- Visual formats (113): <https://motionapp.com/library/formats/> · example: <https://motionapp.com/library/formats/problem-agitation>
- Hook tactics (33): <https://motionapp.com/library/hooks/tactics/> · example: <https://motionapp.com/library/hooks/tactics/price-anchor>
- Creative mechanics (8): <https://motionapp.com/library/creative/mechanics/> · example: <https://motionapp.com/library/creative/mechanics/trojan-horse>
- Creative Strategy Engine (angles/personas/awareness): <https://motionapp.com/library/frameworks/creative-strategy-engine>
- Hook Writing (8 triggers, awareness adaptation, output contract): <https://motionapp.com/library/frameworks/hook-writing>
- Voice & copy standards (AI-tell blocklist, reading level): <https://motionapp.com/library/frameworks/voice-copy-standards>
- Other frameworks: `brand-intake`, `competitor-analysis`, `creative-analysis`, `hook-analysis`, `product-catalog`, `review-audit` under <https://motionapp.com/library/frameworks/>
- Glossary (49 terms): <https://motionapp.com/library/glossary/> — `creative-fatigue`, `frequency`, `statistical-significance`, `thumbstop-rate-hook-rate`, `hold-rate`, `creative-concept-vs-variant`, `a-b-test-split-test`, `learning-phase`
- Audience library (97 personas): <https://motionapp.com/library/audiences/>
- Library sitemap: <https://motionapp.com/library/sitemap.xml>

**Creative genome / tagging**
- Motion AI Tagging (7 dimensions in 4 groups): <https://help.motionapp.com/en/articles/12461770-getting-started-with-ai-tagging-in-motion>
- Motion naming conventions for auto-grouping: <https://help.motionapp.com/en/articles/10024185-streamline-and-automate-your-motion-reports-with-naming-conventions>
- Motion comparative reports: <https://help.motionapp.com/en/articles/8757626-identify-creative-trends-with-comparative-reports>
- Motion launch analysis: <https://help.motionapp.com/en/articles/9197523-getting-started-with-launch-analysis>
- Motion custom tagging: <https://motionapp.com/blog/centralize-your-creative-insights-with-motions-custom-tagging>
- Foreplay Content Style Filters (9 values): <https://www.foreplay.co/post/introducing-content-style-filters>
- Foreplay ad tagging: <https://www.foreplay.co/post/all-new-ad-tagging-in-foreplay>

**Metrics, testing, fatigue**
- Key creative performance metrics (hook/hold/CTR benchmarks): <https://motionapp.com/blog/key-creative-performance-metrics>
- Facebook ad creative KPIs: <https://motionapp.com/blog/facebook-ad-creative-kpis>
- Thumbstop anatomy + $100/3-day test budget: <https://motionapp.com/thumbstop-guide/how-to-stop-a-scroll-in-3-seconds>
- Thumbstopping ads guide: <https://motionapp.com/thumbstop-guide/how-to-create-thumbstopping-ads>
- 3-phase testing framework (Ben&Vic): <https://motionapp.com/blog/ultimate-guide-creative-testing-2025>
- Ad fatigue (rotation cadence, component decay order): <https://motionapp.com/blog/ad-fatigue>
- Wear-in / consistency counter-argument (Binet, System1): <https://motionapp.com/blog/why-ads-resist-creative-fatigue>
- Andromeda operator round-table: <https://motionapp.com/blog/andromeda-impact-on-bfcm>
- Creative iterations: <https://motionapp.com/blog/creative-iterations-for-winning-ads>
- Offer comparison: <https://motionapp.com/blog/comparing-how-different-offers-perform>

**Production and formats (practitioner)**
- 200+ ads/week production system (Savannah Sanchez): <https://motionapp.com/blog/how-to-build-a-high-volume-ad-production-system-for-meta-and-tiktok-in-2026>
- Savannah Sanchez format library with vertical fit: <https://www.foreplay.co/post/savanah-sanchez-ad-formats>
- Unicorn ad creative (Dara Denney): <https://www.foreplay.co/post/how-to-identify-create-unicorn-ad-creative-with-dara-denney>
- UGC ad scripts: <https://motionapp.com/blog/how-to-write-ugc-ad-scripts> · UGC briefs: <https://motionapp.com/blog/ugc-briefs>
- Demonstration ads: <https://motionapp.com/blog/demonstration-ads-for-facebook-tiktok> · Social proof: <https://motionapp.com/blog/social-proof-facebook-ads>

**AI creative**
- AI ad creative at scale, AdCrate / ArcAds (b-roll interleaving rule): <https://motionapp.com/blog/ai-ad-creative-alex-cooper>
- Building video ads with AI: <https://motionapp.com/blog/how-to-build-video-ad-with-ai>
- AI fundamentals in DTC: <https://motionapp.com/blog/using-ai-in-dtc-advertising-apply-the-fundamentals>
- Meta gen-AI transparency (label placement, detection since 2026-06-01): <https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/>

**Competitive intelligence**
- Foreplay ad-library MCP (`public.api.foreplay.co/mcp`): <https://www.foreplay.co/post/ad-library-mcp>
- Foreplay API launch: <https://www.foreplay.co/post/api-launch>
- Analysing top-performing hooks by days-running: <https://www.foreplay.co/post/how-to-analyze-top-performing-hooks>
- Foreplay `llms.txt`: <https://www.foreplay.co/llms.txt> · sitemap: <https://foreplay.co/sitemap.xml>

**Secondary / flagged**
- Video length "5–15 s" and "+23% brand recall": <https://www.foreplay.co/post/how-long-should-a-facebook-video-ad-be> — **[FOLKLORE]**
- Industry CTR table: <https://www.foreplay.co/post/average-click-through-rate-for-facebook-ads> — **[FOLKLORE]**
- Landing-page strategy: <https://www.foreplay.co/post/landing-page-strategy>

**Companion dossiers in this repo (authoritative for API surface — do not re-derive)**
- `docs/research/meta-video-creative.md` — upload, `asset_feed_spec`, placement customization, per-placement specs and char limits (§9), CTA enum (§10), Advantage+ opt-out (§8), AI creative rules (§13)
- `docs/research/meta-insights-measurement.md` — metric field names, video-quartile fields, retention caps, breakdown opt-ins, aggregation gotchas
- `docs/research/meta-policy-compliance.md` — AI disclosure (SIEP vs detection), FTC Reviews & Testimonials Rule, EU AI Act Art. 50
- `docs/research/meta-campaign-publishing.md`, `meta-optimization-controls.md`, `meta-api-foundations.md`
