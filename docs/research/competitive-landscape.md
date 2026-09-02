# Competitive Landscape — Who Already Automates Meta Advertising

**Compiled:** 2026-09-02
**Scope:** Every platform that automates some or all of the Meta (Facebook/Instagram) advertising loop — AI creative generation, publishing via the Marketing API, and performance-driven optimisation — as of September 2026.
**Audience:** Engineers designing a fully autonomous Meta ads platform (human supplies business info + budget + credentials; everything else runs unattended).

---

## 0. How to read this document

Every non-obvious claim carries a source URL. Confidence is tagged inline:

| Tag | Meaning |
|---|---|
| `[OFFICIAL]` | Read directly off the vendor's own site / official docs / package registry on 2026-09-02 |
| `[SECONDARY]` | Third-party (review site, competitor blog). Directionally right, treat numbers as approximate |
| `[UNVERIFIED]` | Could not confirm. Stated as a gap, not as a fact |

**Method note / gotcha for future research runs:** `developers.facebook.com` and `www.facebook.com/business/*` return HTTP 400 to plain `curl` (bot challenge) but are readable through a rendering fetcher. G2, Capterra, Trustpilot and Reddit all block plain HTTP clients; Trustpilot is readable through a rendering fetcher, G2/Capterra/Reddit are not. PyPI and the npm registry are unauthenticated and are the *fastest reliable way* to date-stamp Meta SDK/CLI releases.

---

## 1. Executive summary — the honest one-paragraph answer

There is no shortage of companies in this space; there are roughly **60+ live products** touching some part of the Meta ads loop. But the market is sharply stratified, and almost nobody closes the loop:

1. **Creative generation is commoditised and increasingly distrusted.** AdCreative.ai (4.2M claimed users), Creatify, Arcads, Omneky, The Brief (ex-Creatopy) and a long tail of AI-UGC tools all generate ads cheaply. Their Trustpilot scores are brutal — AdCreative.ai 3.4/5 with **33% one-star**, Arcads 2.7/5 with **46% one-star**, Omneky 2.9/5 with **47% one-star** — and the complaints are consistent: unusable output quality, opaque credit burn, and predatory billing. The single loudest market signal of 2025-26 is that **Icon (icon.com), which launched as "The AI Admaker" and raised $30M+ from Founders Fund and OpenAI/DeepMind leaders, pivoted to selling *human*-filmed UGC at $1,000 for 6 ads, explicitly marketed as "no AI / 100% real"**. ([icon.com](https://icon.com/))
2. **Creative analytics is a healthy, well-funded, well-liked layer** — Motion ($750–$1,200/mo), Foreplay ($59–$459/mo), Atria ($129–$959/mo), Superads ($125/mo+), VidMob, Neurons, Segwise. These tools tell a human what to make next. They do not make it and they mostly do not launch it.
3. **Campaign automation is a mature, rules-based commodity** — Revealbot/Bïrch, Madgicx, AdEspresso, Adzooma, Smartly, Hunch. These are IF-THEN engines with AI chat bolted on top, priced against ad spend. Several have decayed: **Zalster's domain is dead, Trapica serves an empty page, Consumer Acquisition was absorbed into Brainlabs, Marin Software was acquired by Zax Capital, Creatopy renamed itself The Brief, vidyo.ai renamed itself quso.ai.**
4. **The "closed loop" claimants are thinner than their marketing.** Creatify, Omneky, Enhencer, Segwise, Atria and Metadata.io all claim generate→launch→measure→improve. Metadata.io is the most honest about it: it explicitly says a human reviews "budget, approvals, channel structure, and pipeline evidence **before anything goes live**." ([metadata.io](https://metadata.io))
5. **Meta itself is now the most dangerous competitor, and it changed the game in April 2026** by shipping an **official Ads CLI** (`pip install meta-ads`, package "Official CLI for the Meta Marketing API") under a new documentation section called **"Ads AI Connectors."** ([PyPI meta-ads](https://pypi.org/project/meta-ads/), [Meta Ads CLI overview](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-cli/ads-cli-overview)) Meta is deliberately making agentic ad operation a first-party, free primitive. Any moat built on "we wrap the Marketing API nicely" has an expiry date.

**The gap is not creative generation, not API plumbing, and not dashboards. It is the closed measurement→learning→creative-specification loop that survives contact with reality: policy rejections, learning-phase noise, attribution lag, and creative fatigue — operated with no human in the seat.** Nobody verifiably does this today.

---

## 2. Market map — four layers plus the platform

```
LAYER 0  PLATFORM (Meta itself)
         Advantage+ suite, asset_feed_spec, degrees_of_freedom_spec,
         generative_asset_spec, Ads AI Connectors / Ads CLI
         -> free, native, improving, and eats the layer above it

LAYER 1  CREATIVE GENERATION            "makes the asset"
         AdCreative.ai, Creatify, Arcads, Omneky, Pencil (Brandtech),
         The Brief (ex-Creatopy), HeyGen, Synthesia, Captions, OpusClip,
         quso.ai, MakeUGC, TopView, Higgsfield, Icon (now human)

LAYER 2  CREATIVE ANALYTICS             "tells you what to make next"
         Motion (+Runneth), Foreplay, Atria, Superads, VidMob,
         Neurons, Segwise, Marpipe (multivariate)

LAYER 3  CAMPAIGN AUTOMATION / DCO      "operates the account"
         Revealbot/Bïrch, Madgicx, Smartly, Hunch, AdEspresso, Adzooma,
         Celtra, Storyteq, Bannerflow, Enhencer, Skai

LAYER 4  CLAIMED FULL AUTONOMY          "does all of it"
         Creatify (Ad Launcher + Performance Agent), Omneky (Agent),
         Enhencer (Eddy), Segwise (agents), Metadata.io (B2B),
         Madgicx (AI Marketer), Atria (Radar)
```

Almost every vendor sits in exactly one layer and claims two. The commercial reality: **Layer 1 is a race to zero, Layer 2 has the happiest customers and the best margins, Layer 3 is being repriced by Meta's own automation, and Layer 4 is mostly Layer 2 or 3 with an LLM chat box.**

---

## 3. LAYER 0 — Meta itself (the competitor that matters most)

### 3.1 Meta shipped an official Ads CLI in April 2026

This is the single most consequential competitive fact in this document, and it is not widely discussed.

**Docs:** `https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-cli/ads-cli-overview` `[OFFICIAL]`

> "**Ads CLI is a command-line tool** for managing Meta advertising from your terminal."

**Package:** `meta-ads` on PyPI — summary string: *"Official CLI for the Meta Marketing API. Manage campaigns, ad sets, ads, creatives, catalogs, datasets, and insights from your terminal."* `[OFFICIAL]` ([pypi.org/pypi/meta-ads/json](https://pypi.org/pypi/meta-ads/json))

| Version | Uploaded |
|---|---|
| 1.0.0 | 2026-04-29T16:46:03 |
| 1.0.1 | 2026-04-29T18:14:54 |
| 1.1.0 | 2026-06-17T23:58:54 |

**Install & auth (verbatim from Meta's Get Started page):**

```bash
pip install meta-ads
# or from source:
uv sync            # then `uv run meta ...`

export ACCESS_TOKEN=your_access_token
export AD_ACCOUNT_ID=act_123456
# or a .env file containing ACCESS_TOKEN=<ACCESS_TOKEN>

meta auth status
```

> "**Important:** Ads CLI requires a system user access token to authenticate for programmatic access."

**Required scopes** (exact list, from Meta's Get Started page) `[OFFICIAL]`:

```
business_management
ads_management
pages_show_list
pages_read_engagement
pages_manage_ads
catalog_management
read_insights
```

**Setup sequence Meta documents:** create an *admin* system user in Meta Business Suite → Settings → Users → System Users; assign assets (datasets, ad accounts, business Pages, product catalogs); add the system user as **App Admin** in Meta for Developers; generate the token in Business Suite.

**Command surface** — pattern is `meta ads <resource> <action> [options]`:

| Command | Purpose |
|---|---|
| `meta auth` | Manage authentication (`meta auth status`) |
| `meta ads adaccount` | list, get, current |
| `meta ads campaign` | list, get, create, update, delete |
| `meta ads adset` | list, get, create, update, delete |
| `meta ads ad` | list, get, create, update, delete |
| `meta ads creative` | list, get, create, update, delete |
| `meta ads catalog` | list, get, create, update, delete |
| `meta ads insights` | query with date ranges, breakdowns, custom metrics |
| `meta ads page` | list Pages |

Worked examples Meta publishes:

```bash
meta ads campaign list
meta ads campaign create --name "Sales Campaign" --objective OUTCOME_SALES --daily-budget 5000
meta ads insights get --date-preset last_7d
meta ads insights get --fields spend,impressions,ctr,cpc
meta ads creative create --name "My Ad" --page-id <PAGE_ID> --image ./banner.jpg
meta ads campaign list --output json
```

Note `--daily-budget 5000` — budgets are in **minor units (cents)**, consistent with the Marketing API. Note `--objective OUTCOME_SALES` — the ODAX objective enum, not the legacy `CONVERSIONS`.

Meta's own **Tutorials and Recipes** page covers: "Finding IDs" (ad account, Business Page, Business IDs), a **seven-step end-to-end campaign walkthrough** ("authentication, campaign creation, ad set configuration, creative development, ad setup, and activation"), **"Scripting and Automation"** (env-based config, non-interactive execution, JSON output parsing, exit-code handling **for CI/CD workflows**), and resource cleanup with cascading deletes. ([tutorials-and-recipes](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-cli/tutorials-and-recipes)) `[OFFICIAL]`

**Why this matters for the build:** Meta is not merely tolerating agents; it is shipping the CI/CD-shaped tooling for them, for free, under a section literally named *Ads AI Connectors*. The "we can drive the Marketing API" pitch is now table stakes. Third-party MCP servers (see §7) were the 2025 story; Meta absorbed it in 2026.

### 3.2 Marketing API version state

| Signal | Value | Source |
|---|---|---|
| `facebook-business` Python SDK 25.0.0 | 2026-03-10 | [PyPI](https://pypi.org/pypi/facebook-business/json) `[OFFICIAL]` |
| `facebook-business` 25.0.3 | 2026-07-17 | same |
| `facebook-business` **26.0.0** | **2026-08-06** | same |
| `facebook-business` **26.0.1** (current) | **2026-08-25** | same |
| Meta docs code samples still show | `https://graph.facebook.com/v25.0/act_<AD_ACCOUNT_ID>/adcreatives` | [asset-feed-spec doc](https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/asset-feed-spec) `[OFFICIAL]` |
| npm `@mikusnuz/meta-ads-mcp` 1.4.1 (2026-08-06) claims | "Meta Marketing API **v26.0** — 135 tools" | [npm](https://registry.npmjs.org/-/v1/search?text=meta%20ads%20mcp) `[SECONDARY]` |

**Practical read:** v26.0 is the newest version (SDK cut 2026-08-06); v25.0 is the previous one and is what Meta's own prose docs still hard-code in samples. Build against v26.0, but expect docs to lag by one version — a classic day-losing mismatch.

### 3.3 Meta reorganised its developer docs URLs

Old: `https://developers.facebook.com/docs/marketing-api/...`
New: `https://developers.facebook.com/documentation/ads-commerce/marketing-api/...`

Both prefixes still resolve for some pages, but the *canonical* links inside current pages use `/documentation/ads-commerce/`. Examples confirmed live: `/documentation/ads-commerce/marketing-api/ad-creative/asset-feed-spec`, `/documentation/ads-commerce/marketing-api/advantage-catalog-ads`, `/documentation/ads-commerce/catalog`, `/documentation/ads-commerce/marketing-api/audiences/guides/dynamic-product-audiences`, `/documentation/ads-commerce/marketing-api/reference/adgroup/insights`. Meanwhile `/docs/marketing-api/generative-ai/` and `/docs/marketing-api/advantage-plus-creative` **404**. Any hard-coded doc links or scraped-doc RAG index built before mid-2026 is stale. `[OFFICIAL]`

### 3.4 The AdCreative fields that carry Meta's free AI

Read directly off `AdCreative` reference (`/docs/marketing-api/reference/ad-creative/`) `[OFFICIAL]`:

| Field | Type / note | Meta's own description |
|---|---|---|
| `degrees_of_freedom_spec` | object | *"Specifies the types of transformations that are enabled for the given creative"* — this is the switch for Advantage+ creative enhancements |
| `asset_feed_spec` | object | *"Used for Dynamic Creative to automatically experiment and deliver different variations of an ad's creative."* |
| `contextual_multi_ads` | `AdCreativeContextualMultiAds` | multi-ad contextual delivery |
| `generative_asset_spec` | `AdCreativeGenerativeAssetSpec` | Meta's generative-asset hook on the creative object |

`asset_feed_spec` structure (verified field names) `[OFFICIAL]`:

```jsonc
{
  "asset_feed_spec": {
    "images":  [ { "hash": "<IMAGE_HASH>" } ],
    "videos":  [ { "video_id": "<ID>", "thumbnail_url": "...", "url_tags": "..." } ],
    "titles":       [ { "text": "..." } ],
    "bodies":       [ { "text": "..." } ],
    "descriptions": [ { "text": "..." } ],
    "link_urls":    [ { "website_url": "https://..." } ],
    "call_to_action_types": ["SHOP_NOW", "LEARN_MORE"],
    "ad_formats":   ["SINGLE_IMAGE"],          // also SINGLE_VIDEO, AUTOMATIC_FORMAT
    "optimization_type": "REGULAR"
  }
}
```

Documented constraints that will cost you a day `[OFFICIAL]`:
- Asset **customization rules** require *"at least two target customization rules in `asset_feed_spec`"*.
- A **Dynamic Creative** feed must **not** include customization rules — the two modes are mutually exclusive.
- You **cannot convert between ad format types**, and you **cannot remove `asset_feed_spec` entirely** on an update. The creative is effectively immutable in shape once created; iterate by creating new creatives, not by mutating.

`AdCreativeGenerativeAssetSpec` exists as a referenced type; **its field list could not be retrieved** — see §12 Open Questions. `[UNVERIFIED]`

### 3.5 Advantage+ — what it already does for free

Confirmed from Meta's own docs: **Advantage+ catalog ads** — *"promote relevant items from an entire catalog across any device"*, requiring (1) a catalog feed with images/descriptions/prices, (2) App Events or the Meta Pixel for conversion tracking and audience building, (3) ads built from the catalog feed. ([advantage-catalog-ads](https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads)) `[OFFICIAL]`

The broader Advantage+ product taxonomy (Advantage+ sales campaigns, Advantage+ app campaigns, Advantage+ audience, Advantage+ placements, Advantage+ creative / standard enhancements, and the specific generative features — text generation, image expansion, background generation, image animation) **could not be verified from Meta first-party sources in this pass** because `facebook.com/business/*` is login-walled and the corresponding `/docs/marketing-api/advantage-plus-creative` path now 404s. Treat the taxonomy as `[UNVERIFIED]`; treat `degrees_of_freedom_spec` as the verified API-level control surface. See §12.

**The strategic point stands regardless of taxonomy detail:** Meta gives away, at zero marginal cost, (a) automated audience/placement/budget allocation, (b) creative variation and enhancement on the creative object itself, (c) catalog-driven per-SKU personalisation, and now (d) an official CLI for agents. Every third-party vendor in §5 and §6 is renting space on top of that, and Meta re-prices the rent annually.

---

## 4. LAYER 1 — Creative generation

### 4.1 AdCreative.ai

**Does:** static ad creatives, product photoshoots, fashion photo/video, AI image + video generation, ad copy, UGC-style video, "Instant Ads", Creative Scoring (predicts performance pre-launch), Creative Insights, Competitor Insights, **Compliance Checker** ("Check ads for brand, platform & policy compliance, avoid violations"), Buyer Personas. Claims "**Ad Platform Integrations**" and "trained on patterns learned from **$35B+ in ad spend data**". ([adcreative.ai](https://www.adcreative.ai/)) `[OFFICIAL]`

**Publishes to Meta?** Claims platform integrations and "ready-to-launch" ads; **there is no evidence of autonomous, unattended publishing** — the product is an asset factory with export/integration. `[UNVERIFIED]` for true autonomous launch.

**Optimisation loop?** No. It has *pre-launch* scoring and *post-hoc* Creative Insights, but no evidence of an automated act-on-performance loop.

**Pricing (monthly list, off the live page)** `[OFFICIAL]`:

| Tier | Credits / mo | Brands | $/mo |
|---|---|---|---|
| Starter | 10 | 1 | **$39** |
| Starter | 15 | 2 | **$89** |
| Starter | 30 | 2 | **$139** |
| Starter | 50 | 2 | **$189** |
| Professional (Pro) | 50 | 10 | **$249** |
| Professional | 75 | 10 | **$339** |
| Professional | 100 | 10 | **$400** |
| Ultimate | 100 | 25 | **$749** (billed quarterly; list $999) |
| Ultimate | 150 | 25 | **$825** |
| Ultimate | 200 | 25 | **$1,049** |

Toggles: Quarterly = 25% off, Yearly = 50% off. A quarterly view showed Starter at $29 / $65 / $105 / $145. Pro tier copy: *"It's like hiring an ROI-driven designer and copywriter for just $249 a month."* Bundled: "Unlimited Photos by iStock — $900 value", Text Generator AI, Ad Creative Insight AI.

**Traction claim:** "+4,200,000 users", "Over 1 Billion Ad Creatives Generated".

**Weaknesses (Trustpilot, [trustpilot.com/review/adcreative.ai](https://www.trustpilot.com/review/adcreative.ai))** `[SECONDARY]`: **TrustScore 3.4/5 across 4,488 reviews — 55% five-star but 33% one-star**, a bimodal distribution that screams billing dispute rather than product dispute. Verbatim themes: *"unexpected charges occurring automatically after ending free trial periods"*; *"a second unauthorised payment was taken from our business bank account for a renewal we never signed up to"*; support *"categorically refused a refund"* and *"refused to escalate my ticket to senior management"*; *"they attempted to charge my card three more times after cancellation"*.

**Read:** enormous top-of-funnel, catastrophic retention economics, monetised through subscription friction. Not a technology moat.

### 4.2 Creatify — the closest thing to a real closed loop in the SMB tier

**Does:** URL→video ads, AI actors, "Creative Agent", "Ad Flow", "Ad Clone", "Ad Insights", **"Ad Launcher (Meta / TikTok / AppLovin)"**, **"AI Performance Agent (Meta, Google, TikTok, AppLovin)"**, Competitor Ad Tracker over **10M+ Meta ads**, Brand Spaces, Smart Assets, and **"Creatify MCP for Claude & ChatGPT"**. ([creatify.ai/pricing](https://creatify.ai/pricing)) `[OFFICIAL]`

Homepage states the loop explicitly as four steps — **DISCOVER → CREATE → LAUNCH → OPTIMIZE**, with LAUNCH described as *"Push live to social channels instantly / Connect your ad accounts once, launch forever / Auto-optimized for each platform's specs / Built-in A/B testing across campaigns"* and OPTIMIZE as *"See spend, ROAS, and CTR for every creative / Compare performance across all your variants / Know exactly which hooks and angles convert"*. ([creatify.ai](https://creatify.ai/)) `[OFFICIAL]`

**Traction claims:** 18,000+ brands and agencies, 30M+ ads analyzed, 15M+ ads created, $1B+ ad spend, "Rated 4.8/5 on G2".

**Pricing** `[OFFICIAL]`:

| Tier | $/mo | Credits | Key gates |
|---|---|---|---|
| Starter | **$39** | 100 | 300 AI actors, 200+ templates, 50+ models, video ≤2 min, 1 seat, **no Agent, no Ad Launcher, no Performance Agent** |
| Pro | **$99** | 300 (ladder: 300 / 500 / 1,000 / 2,000 / 5,000) | 1,500 AI actors + 3 custom avatars, 500+ templates, 100+ models, Creative Agent, **Ad Launcher (Meta/TikTok/AppLovin)**, **AI Performance Agent**, Competitor Ad Tracker (up to 10 brands), MCP, 10 GB Smart Assets, video ≤10 min, up to 5 seats (1 incl.), up to 5 Brand Spaces (2 incl.) |
| Enterprise | custom | custom | Creatify Studio (done-for-you), **custom AI model fine-tuning**, white-label, **enterprise SLA & IP assignment**, dedicated AM |

Annual saves up to 50%.

**Weaknesses (Trustpilot, [trustpilot.com/review/creatify.ai](https://www.trustpilot.com/review/creatify.ai))** `[SECONDARY]`: **4.0/5 from 824 reviews, 78% five-star, 16% one-star.** Verbatim: *"All scenes are messed up, language is absolutely different than the language i wrote in the prompt."*; *"They charged me $588 for an annual plan but completely hide their credit consumption."*; *"Unsubscribing is extremely difficult making you go through page after page with offers"*; *"150-200 credits doesn't even give you a usable result. This means you are paying around $50 for a sub standard AI generated video."*

**Read:** Creatify is the most direct competitor to a "full automation" product at the SMB price point. Its weakness is exactly the one this project must beat: **credit economics make per-video cost unpredictable, and output fidelity is unreliable** — which is fatal when nobody is reviewing before spend.

### 4.3 Arcads

**Does:** AI UGC video with 1,000+ AI actors, lip-sync, emotion control, localisation in 30+ languages; an **"AI Ads" infinite-canvas workflow builder**; a public **video-generation API** at `arcads.live` ("AI Video Generator API — 1,000+ AI Actors"); and a first-party **Claude Code / Cursor integration** ([github.com/krusemediallc/arcads-claude-code](https://github.com/krusemediallc/arcads-claude-code) — "Create AI marketing videos and images using your Arcads account, powered by AI agents in Claude Code or Cursor"). Also ships a free tool that *"repurpose[s] winning Facebook ads for your brand — transcript, audio, and…"*. `[OFFICIAL]`

**Publishes to Meta?** No evidence. Asset generation only.

**Pricing: deliberately hidden.** `arcads.ai/pricing`, `/plans`, `/price` all 404. `[OFFICIAL]` Third-party breakdown `[SECONDARY]` ([wireflow.ai/blog/arcads-pricing](https://www.wireflow.ai/blog/arcads-pricing), 2026-07-14):

| Plan | List | With permanent 30% discount | Annual | Credits | AI videos | AI actors |
|---|---|---|---|---|---|---|
| Starter | $110/mo | $77/mo | $88/mo | 8,000 | up to 50 | 300 |
| Creator | $220/mo | $154/mo | $176/mo | 16,000 | up to 100 | 1,000 |
| Pro | $550/mo | $385/mo | $440/mo | 40,000 | high volume | 1,500 |

> "Arcads does not have a public pricing page. As of July 2026 the /pricing URL returns a 404, and the only way to see plan details is to create an account first."

**Weaknesses (Trustpilot, [trustpilot.com/review/arcads.ai](https://www.trustpilot.com/review/arcads.ai))** `[SECONDARY]`: **2.7/5 from 170 reviews — 44% five-star, 46% one-star.** Verbatim: *"Videos produced look NOTHING like their ads - glitchy/not lip synced & clearly AI."*; *"Four emails over 23 days and Arcads has not responded once."*; plus auto-renewal and refund complaints.

### 4.4 Icon (icon.com) — the pivot that tells you the most

**What happened:** Icon launched as "The AI Admaker." As of 2026-09-02 its homepage sells **"The Agency — 6 Human UGC ads filmed & edited for $1000 (no AI / 100% real)"**, with the line *"Icon originally launched as The AI Admaker. Today, we make 6 Human UGC for $1000 (no AI / 100% real)."* ([icon.com](https://icon.com/)) `[OFFICIAL]`

**Model:** brief → creative director call within 24h → **6 unique scripts written before you pay** → ads delivered in **12–16 days** → full refund if you don't love them. 18 curated ad formats (Listicle, Street Interview, TikTok Comment Response, GRWM, skits…). 1,288+ vetted creators; 288+ brands.

**Software layer:** "Admaker 2.0 — Helps our creative team make better ads. Helps your team review + launch + analyze ads & rebook creators." So the AI became internal tooling and a *launch/analyze* console, not the product.

**Positioning:** explicitly "Replaces Billo, Soona, SideShift, Insense, Cohley, GRIN, Aspire, **Motion, Foreplay**, & more ($10K+/mo)" — note it names the *creative analytics* layer as the thing it replaces.

**Funding (self-reported):** *"$30M+ raised. Founders Fund, OpenAI (ChatGPT) + Google DeepMind leaders, Saquon Barkley (NFL), & more"* — 68 investors. Founder Kennan: solo-founded Skio ($105M cash exit, $32M ARR, $8M raised, YC S20).

**Trustpilot ([icon.com](https://www.trustpilot.com/review/icon.com))** `[SECONDARY]`: **4.0/5 from 75 reviews, 53% five-star, 34% one-star.** Positives centre on turnaround and that *"human creators"* feel *"authentic on camera"*. Negatives: cancellation friction (*"I hit the cancel subscription button so many times and it doesn't take me anywhere."*) and *"need to be patient with a product in rapid development."*

**Why this is load-bearing for your build:** the best-funded, most-hyped AI ad-maker in the category concluded that, at DTC performance standards in 2025-26, **AI-generated UGC did not beat human UGC on the metric that pays**, and moved the AI to the back office. Any plan that assumes "AI video is good enough now" must explain why Icon was wrong.

### 4.5 Omneky

**Does:** the fullest *claimed* stack of any independent — "Creative Generation Pro: **End to end creative workflow to analyze, generate and launch ads**", "Approve & Launch — Easily launch creatives to all ad platforms from a centralized hub", "Campaign Launcher", "Smart Ads — Automate ad creation with AI and performance data", "Brand LLM — Enforce brand standards with fine-tuned LLM", "**Agent** — Ask your ads anything — analyze, generate and launch from one chat", plus **API** and **MCP**. Channels listed: Google, Meta, TikTok, LinkedIn, Reddit, **OpenAI Ads**. Also sells "Creative Services & Media Buying" as a human service. ([omneky.com](https://www.omneky.com/)) `[OFFICIAL]`

Note the "OpenAI Ads" channel — worth tracking as a new demand surface.

**Pricing:** `omneky.com/pricing` 404s at the time of writing; a Pricing nav item exists. `[UNVERIFIED]`

**Weaknesses (Trustpilot, [trustpilot.com/review/omneky.com](https://www.trustpilot.com/review/omneky.com))** `[SECONDARY]`: **2.9/5 from 45 reviews — 36% five-star, 47% one-star.** Verbatim: *"They keep your card information and keep charging your account without your consent."*; *"Poorly designed AI with a nice packaging around it"*; *"Very difficult to get any support or get contact with a human"*; one customer *"reported losing 75 credits simply for viewing content without downloading or taking action."*

**Read:** the architecture Omneky describes is the architecture this project wants. Its reputation suggests the hard part was never the architecture.

### 4.6 Pencil / Pencil Pro (Brandtech Group) — the enterprise answer

**Positioning:** *"Marketing has an AI operating system now — The only platform that aggregates every AI model, enforces enterprise governance, and turns production savings into media growth."* Live at **trypencil.com** (note: `pencil.ai` does not resolve). ([trypencil.com](https://trypencil.com/)) `[OFFICIAL]`

**Differentiator = procurement, not generation.** It aggregates *"the best models from OpenAI, Google, Adobe, Runway, and Bria into one orchestration layer, so you can always use the right model."* Enterprise controls shipped by default: **SOC 2 Type II**, **No-Train Policy** ("Your data never trains models"), **Full IP Indemnification** ("Own everything you create"), regional data compliance (EU/US/APAC), role-based access, brand-safety guardrails.

**Claims:** 50% reduction in creative production costs, **79% ROAS improvement**, 24x markets scaled simultaneously. Case studies include Experian.

**Products:** Editor, Workflows, Infinite Canvas, Content Hub, Integrations. Sales-led ("Book a demo"), no public pricing. `[OFFICIAL]`

**Read:** Pencil concedes the model layer entirely and monetises governance + orchestration. That is a real, durable moat for enterprise — and completely unavailable to a startup targeting SMBs.

### 4.7 The Brief (formerly Creatopy) — the one that actually publishes

`creatopy.com` now **redirects to thebrief.ai**, with a banner "Creatopy is now The Brief." ([thebrief.ai](https://www.thebrief.ai/)) `[OFFICIAL]`

**Does:** *"The Brief unifies ad generation, adaptation, deployment, and optimization in one platform. Brand-trained AI. Fully editable outputs. **Direct publishing and ad serving across 40+ ad networks.**"* Ad Studio, Canvas, video ads, product photography, AI Resize, PSD and Figma import, timeline-based animation, HTML5/AMP export. Claims 70% faster campaign launches, 40% lower cost per asset, 50% fewer [revisions].

**Pricing** `[OFFICIAL]`, "no credits, no counters, just plans":

| Plan | $/mo | Billed |
|---|---|---|
| Pro (individual) | **$29** | $348/yr |
| Ultra (individual) | **$79** | $948/yr — includes **ad serving through The Brief** and multi-market campaigns |
| Team / Scale / Enterprise | custom | — |

Every plan includes full Ad Studio, AI generation and export (JPG, PNG, WEBP, GIF, HTML5, MP4, PDF, AMP); Pro includes 5 Brand Kits, 250 GB storage, Shopify/Google Drive/Dropbox integrations. Monthly→yearly saves ~26%. 7-day trial, no card.

**Read:** the cheapest credible "generate + actually publish/serve" product on the market. Its ad-serving orientation (own ad server, 40+ networks) is display-heritage, not Meta-native performance — but the $29–$79 price point resets what SMBs will pay.

### 4.8 Avatar / short-form video engines (upstream suppliers, not competitors)

| Product | Pricing `[OFFICIAL]` | Notes |
|---|---|---|
| **HeyGen** ([pricing](https://www.heygen.com/pricing)) | Free $0 (3 videos/mo, ≤1 min, 500+ stock avatars, 1 custom avatar, 30+ languages); **Creator $29/mo** (600 credits, ≤30 min, 1080p, voice cloning, 175+ languages, credit rollover); **Pro $49/mo** (1,000 credits, 4K, all advanced models) | "100,000+ businesses"; G2 #1 Fastest Growing Product 2025 |
| **Synthesia** ([pricing](https://www.synthesia.io/pricing)) | "New lower prices — plans now starting from **$18/month**, save 38%"; Basic $0 with **1,200 credits/mo**; credits are *"the shared currency across all AI usage-based features"* | 240+ avatars, 1,000+ voices, 160+ languages; **SOC 2 Type II + ISO 42001 + GDPR**; L&D/enterprise-comms oriented, not performance ads |
| **Captions** ([pricing](https://captions.ai/pricing)) | **Max $24.99/mo** (500 credits); **Scale $69.99** (1,400); **Scale 2x $139.99** (2,800); **Scale 4x $279.99** (5,600); Enterprise custom. *"Features and prices reflect iOS plans only."* | AI actors / digital twins, chat-based editor, generated B-roll, music, SFX |
| **OpusClip** ([opus.pro](https://www.opus.pro/pricing)) | (pricing page renders client-side; tiers not captured) `[UNVERIFIED]` | AI Producer, animated captions, AI Reframe, ClipAnything, social scheduler |
| **quso.ai** | `vidyo.ai` now **redirects to quso.ai** — the brand no longer exists under the old name `[OFFICIAL]` | repurposing/short-form |
| **MakeUGC** ([makeugc.ai](https://www.makeugc.ai/)) | promo: "Unlimited **Seedance 2.5** for 30 days" | Talking Actor, Custom AI Avatar, B-roll video, Product In Hand |
| **TopView** ([topview.ai](https://www.topview.ai)) | — | "AI Video Agent for Short Films & Marketing Videos" |
| **Higgsfield** ([higgsfield.ai](https://higgsfield.ai/)) | — | "AI-native creative suite": Cinema Studio 4.0, **Marketing Studio**, Viral Presets, **MCP & CLI**, Canvas, Plugins; exposes Genjutsu (motion transfer / object replacement), Gemini Omni 1.1 Flash, Flux 3.0 Video Upscale, Recraft V4 Styles |

**Build implication:** none of these is a competitor to a full-automation platform; all are *substitutable suppliers*. Do not build avatar rendering. Do keep the video-model layer swappable — Higgsfield alone rotated through four named model families in one release cycle.

---

## 5. LAYER 2 — Creative analytics ("what should we make next")

This is the layer with the healthiest economics and the happiest customers. It is also the layer that a genuinely autonomous system must *internalise* rather than compete with.

### 5.1 Motion (motionapp.com) + Runneth

**Pricing** `[OFFICIAL]` ([motionapp.com/pricing](https://motionapp.com/pricing)) — priced on **analysed ad spend**, not seats:

| Plan | $/mo | Spend band | Included |
|---|---|---|---|
| Starter | **$750** | up to $50k/mo | *"A 24/7 analyst."* Your own always-on Motion AI brain (**dedicated VM**), unlimited seats & ad accounts, AI tags & tasks, ad leaderboard, creative analytics, **pre-watches, tags & analyzes every creative you've run**, inspo, benchmarks, full data & **MCP access**, ask in Slack (ships briefs, hooks & reports), **Routines** (daily/weekly reports, iteration finders, alerts) |
| Pro | **$1,200** | over $50k/mo | *"A real AI-enabled operator."* + unlimited view-only guests, attribution integrations (**Northbeam, Google Analytics**), **first-pass video QA in Slack**, personalised onboarding |
| Growth | custom | over $125k/mo | *"An embedded AI team."* + dedicated CSM and solutions engineering, **"Closed-loop pipelines built with you, signal to launched ad"**, advanced security, private Slack |

That Growth-tier line — *"Closed-loop pipelines built with you, signal to launched ad"* — is the most explicit closed-loop claim in the category, and note that it is sold as **bespoke services work at six-figure spend levels**, not as product. That is the current state of the art: the loop exists, but only as consulting.

**Runneth** — Motion's new product, "The AI brain for marketing" ([runneth.com](https://runneth.com)) `[OFFICIAL]`. Slack-native (`@runneth What are our top performing ads this week?` → per-ad CPM/CPC/ROAS/CPA table with explicit *"Pause or replace the creative"* recommendations). Positioned against "Claude Projects" and "Mac Mini" as the alternative. *"Give Runneth access to your tools and it goes way beyond being an analyst. Runneth can make ads, edit videos, design and publish landing pages and much, much more."*

**Read:** Motion is migrating from analytics into agentic execution. It is the most likely incumbent to arrive at full autonomy from the analytics side, and it already owns the creative-performance dataset.

### 5.2 Foreplay

**Products:** Swipe File, **Discovery** (ad search engine over **100M+ ads**), **Spyder** (24/7 competitor tracking), **Lens** (advertising analytics for creative teams), **Briefs**, Chrome extension, mobile app, **API**, **MCP**. ([foreplay.co/pricing](https://www.foreplay.co/pricing)) `[OFFICIAL]`

**Pricing** (monthly / annual), all with unlimited ad spend, +$20 per extra user:

| Plan | Monthly | Annual | Users | Spyder brands | Lens |
|---|---|---|---|---|---|
| Basic | **$59** | $49 | 1 | — | — |
| Workflow | **$175** | $149 | 5 | 15 (unlimited on annual) | 1 brand |
| Agency | **$459** | $389 | 10 | 50 (unlimited on annual) | 10 brands |
| Enterprise | custom | "save up to 80%" | unlimited | — | — |

API credits: 10,000/mo on monthly plans, 20,000/mo on annual. MCP on every tier.

**Read:** pure research/inspiration + analytics. No generation, no publishing. Its value to a builder is as a **competitive-creative corpus** — and note that Foreplay, Atria and Motion all now ship MCP, meaning the "give an LLM your ad data" primitive is already a checkbox, not a differentiator.

### 5.3 Atria (tryatria.com) — the most aggressive loop claim in the analytics tier

**Claims:** trained on **$9B+ ad spend**, 20,000+ teams, 4.9 on G2, **SOC 2 Type II**. *"Built by Meta ad experts. Our agents know what's working, catch what's missing, and tell you exactly what ads to make next."* Slack-native. Agent named **Raya**; monitor named **Radar** ("24/7 AI strategist"). ([tryatria.com](https://www.tryatria.com/)) `[OFFICIAL]`

**Explicit end-to-end claim:** *"End-to-end creative workflow in one platform — Research, Brief, Generate, Launch, Analyze"*, and in its comparison grid against **Motion / Foreplay / "Claude / GPT"** it claims uniquely:
- *"**One-click bulk upload directly to Meta** — 10x faster than manual. Push variants in seconds."*
- *"**Auto-scale winners, auto-pause losers**"*
- *"Proactive AI: works without being prompted"*
- *"Clone image ads using AI and iterate on top performers"*
- *"Customer review mining into ad angles and hooks"*

**Pricing** `[OFFICIAL]` ([tryatria.com/pricing](https://www.tryatria.com/pricing)), annual billing:

| Plan | $/mo | AI credits/mo | Ad accounts | Spend analysed | Seats (+$20 ea) | Storage | Brands followed |
|---|---|---|---|---|---|---|---|
| Core | **$129** | 4,000 | 5 | $500K/mo | 5 | 5 GB | 50 (no AI insights) |
| Plus | **$479** | 10,000 | 10 | $1M/mo | 8 | 1 TB | 100 + AI insights |
| Business | **$959** | 25,000 | unlimited | unlimited | 15 | 5 TB | 200 + AI insights |
| Enterprise | custom | custom | — | — | custom | custom | "End to end creative delivery" |

**MCP:** *"Free & unlimited for now — Atria MCP is live — bring your ad data into Claude, ChatGPT and other agents."* **REST API: 1 credit per request.**

**Read:** the most complete third-party stack at a real price. The tell is "**one-click** bulk upload" and "**auto**-scale winners" — a human clicks, then rules run. It is assisted operation, not autonomy. Also note the pricing axis: **credits + analysed ad spend + seats**, three meters at once.

### 5.4 Superads

*"Your AI paid media expert."* Boards/reports across **Meta, Google, TikTok, LinkedIn**, Superads AI Q&A over your ad account, and **AI Tagging** ("Auto-tag every ad by visual format, hook, product, angle and more"). ([superads.ai](https://superads.ai/)) `[OFFICIAL]`

**Pricing:** Professional **from $125/mo** (billed $1,500/yr) covering **up to $100k monthly ad spend**, then **+$100/mo per extra $100k of ad spend**; Enterprise custom (custom integrations, invoicing, SSO, uptime SLA). Claims 7,000–10,000+ teams. `[OFFICIAL]`

Note one testimonial still says *"Still can't believe it's free!"* — the product moved from free to $125/mo, a useful signal on how hard this layer is to monetise at the bottom.

### 5.5 VidMob — the enterprise creative-data incumbent

*"The only end-to-end creative effectiveness platform."* Products: **Creative Scoring**, Creative Studio, **Creative Analytics**, **Creative Data API & Exports**, Diversity Measurement, Influencer Intelligence. Claim: *"Digital platforms report up to 30% campaign KPI lifts by meeting best practices."* Enterprise, demo-only. ([vidmob.com/product](https://vidmob.com/product)) `[OFFICIAL]`

VidMob's structural advantage is being a platform-blessed creative-data partner across Meta/Google/TikTok — a position that is granted, not built.

### 5.6 Neurons — pre-flight prediction

*"Test & Optimize Your Ads with Neuroscience-Backed AI."* Attention heatmaps, behavioural scores, memory/engagement KPIs, frame-by-frame video impact, object-level attention tracking (logo, product, headline), and generation of *"new visual examples and new creative directions, validated by Neurons AI."* Claims +29% ad recall, +64% brand awareness. Scores "hundreds of video assets in one go". ([neuronsinc.com](https://www.neuronsinc.com)) `[OFFICIAL]`

**Why it matters to an autonomous system:** the single hardest problem in unattended creative generation is **deciding which of 50 generated variants deserves spend before any spend exists**. Neurons sells exactly that prior. AdCreative.ai sells a weaker version ("Creative Scoring"). A build that spends real money on unscreened AI output is strictly worse than one that screens.

### 5.7 Segwise — the cleanest articulation of the loop

*"Creative Analytics & Ad Generation, on Autopilot."* Named agents: **Creative Tagging Agent, Competitor Tracking Agent, Creative Strategy Agent, Creative Generation Agent**, plus Fatigue Tracking. ([segwise.ai](https://www.segwise.ai)) `[OFFICIAL]`

Its own description of the loop, verbatim:

> "**The Segwise loop** — An AI Creative system that makes it easier to produce winning ads with every run. Segwise understands your winning creative patterns → Helps you convert patterns into new creatives → Learns from what goes live → Repeats."

And its framing of the failure modes is the sharpest in the category:

> "**Dead on arrival** — Some creatives never had a chance. They burn budget from the first impression. By the time the numbers confirm the flop, the money is gone."
> "**Winners fatigue quietly** — Fatigue is obvious only after ROAS drops. Every day you miss the signal, you pay for a creative past its peak."
> "**Campaigns starved of creatives** — Ad network algorithms now need more creatives than most teams can produce."

Segments: mobile games, DTC brands, subscription apps, agencies. Outputs statics, videos **and playables**. 7-day trial, no card, "no engineers required". Free tools: Video-to-Playable, Creative Tag Generator.

**Read:** Segwise has the right mental model and the right vocabulary. It is mobile-UA-heritage (playables, MMP-shaped), which is why it is under-known in DTC circles — and why its loop is credible: mobile UA teams have been doing algorithmic creative iteration for years.

### 5.8 Marpipe — multivariate creative testing → catalog

Repositioned from generic multivariate ad testing to **DPA/catalog creative**: Catalog Creative, Product Level Video ("Turn every SKU into a thumb-stopping video"), **Generative Catalogs**, **SKU Optimization** ("Automatically filter out the worst performers"), Feed Management. ([marpipe.com/pricing](https://www.marpipe.com/pricing)) `[OFFICIAL]`

**Notable:** a site-wide banner reads *"Announced: **Meta Partnership to subsidize cost of Marpipe for qualified brands**."* — i.e. Meta is directly subsidising a third-party tool that improves catalog ad creative. That is a strong signal about where Meta wants third parties to add value (feed/catalog quality) versus where it does not (bidding/targeting, which Advantage+ absorbed).

**Pricing:** Feed Management **free**; **Startup $199/mo** (500-SKU cap, 1 output feed, 1 market, 3 live designs); Enterprise banded by SKU count (0–500 / 501–1,000 / …), white-glove. 6,000–7,000+ users, month-to-month, unlimited seats. `[OFFICIAL]`

---

## 6. LAYER 3 — Campaign automation, rules and DCO

### 6.1 Revealbot / Bïrch

Rebranded to **Bïrch** (domain `revealbot.com`, short link `bir.ch`; legal entity "Birch Team, Inc."). ([revealbot.com/pricing](https://revealbot.com/pricing)) `[OFFICIAL]`

**Modules:** **Rules** (condition-based rules at scale), **Stage** (create ads from Google Drive media by duplicating your setups), **Explorer** (track performance, spot fatigue, find top assets), **Hub** (**server-side tracking for Meta**, i.e. CAPI), **Launcher**, top audiences, custom/lookalike audience builder. Integrations: Meta, Google, Snapchat, TikTok Ads, Google Sheets, GA, Slack, **AppsFlyer**, **Wicked Reports**, **Hyros**.

**AI layer:** **Bïrch AI** ("Scale your ad ops with an AI layer across your workflows"), **Bïrch MCP** (New — "Connect Birch to your AI tool"), a **Prompting guide** covering *"Birch AI, **Meta MCP** and Birch MCP"*, and **Routines** (marked "Soon" — "Schedule repeated workflows").

> The existence of a documented "**Meta MCP**" in a partner's prompting guide is the strongest available indication that Meta ships an official MCP server alongside the Ads CLI. **Meta's own MCP documentation could not be retrieved** in this pass — see §12. `[UNVERIFIED]`

**Pricing** — banded on **monthly ad spend across all connected accounts**, with **overage percentages if the band is exceeded**: `[OFFICIAL]`

| Plan | ≤$10K band | Includes |
|---|---|---|
| Essential | listed **$49 / $99 per mo** depending on billing term | Workspaces with Overview, post boosting, reports, activity page, Slack, email support |
| **Pro** (most popular) | **$99/mo** | + **Automated rules and strategies**, Explorer, **Launcher**, Stage (free version), top audiences, custom metrics/timeframes, custom & lookalike audience builder, Slack/Sheets/AppsFlyer/Hyros integrations, live chat |
| Enterprise | custom | + Stage unlimited, onboarding & tech setup help, **no limits and no overages** |

14-day free trial with unlimited access. **On trial expiry, "your automated rules and reports will be disabled"** — a real operational hazard if you build on top of it. 15,000+ clients claimed.

**Trustpilot ([revealbot.com](https://www.trustpilot.com/review/revealbot.com))** `[SECONDARY]`: 3.8/5 from only 18 reviews (55% five-star, 28% one-star). Positive: *"The rules engine is powerful and reliable. It helped us significantly reduce wasted ad spend."* Negative: overage charges after account disconnection or during trials; *"The tool has been buggy and unreliable. Last Friday, due to yet another malfunction, my assistant couldn't launch the creatives."*

Customer quote from their own site, which is the whole category thesis in one line: *"I had to work 8 hours a day on one ad account. With Bïrch, I only need one or two hours. **I just need to work on creatives, because everything else is automated.**"*

### 6.2 Madgicx

**Positioning:** *"Agentic Meta Ads Management AI Platform"*, *"the first Ecom Ad Cloud"*, *"Instead of offering point solutions like our **45+ competitors**, we have everything in one place."* Modules: Optimization (**AI Marketer** — *"works like your personal AI Ad Agency… audit your account, identify opportunities, and tell you exactly what to do next"*), **AI Ads** (creative generation + **"Automated Ad Launch Tool"** + Meta Creative Tracker + *"scale winners automatically"*), Analytics (AI Ad Analyzer), One-Click Report. Official Meta Business Partner (4.5 / 380+ reviews badge). Claims 200,000+ advertisers. ([madgicx.com](https://madgicx.com/), [pricing](https://madgicx.com/pricing)) `[OFFICIAL]`

**Pricing is deliberately opaque.** The pricing page asks "What's your monthly ad spend (USD)?" with bands <$1K, $1K–$2.5K, $2.5K–$5K, $5K–$10K, $10K–$20K, $20K–$30K, $30K+, and then the plan card literally reads **"See price inside the app"** with `$0/mo` rendered. The only public numbers: **Tracking Pro add-on $49/mo** (server-to-server tracking, enhanced conversions, Facebook Click ID support) and a banner "Early-Bird Offer: accurate data analysis for **$29/mo** forever". 7-day free trial. `[OFFICIAL]`

**Weaknesses — the worst reputation in the category.** Trustpilot ([madgicx.com](https://www.trustpilot.com/review/madgicx.com)) `[SECONDARY]`: **TrustScore 1.7/5 across 271 reviews — 50% five-star and 46% one-star**, i.e. a near-perfect bimodal split. Verbatim: *"Started the seven day trial. I cancelled it. They still charged me $70."*; *"I cancelled ON the day the trial ended & was charged 300!!"*; *"payments were taken instantly without proper final confirmation"*; *"they won't respond to refund requests"*; reminder emails *"land in spam or arrive too late to prevent charges."*

**Read:** Madgicx has the most complete *marketed* feature set of any Meta-only tool and the worst trust profile. Both facts are competitively useful: the feature set defines table stakes; the trust profile defines the opening.

### 6.3 Smartly (smartly.io) — the enterprise ceiling

Three suites: **Creative** (Gen-AI production at enterprise scale, DCO), **Media** (full-funnel campaign management, automated workflows, "AI enabled predictive algorithms to optimize bids and budgets"), **Intelligence** (real-time reporting, 1st/3rd-party data integration, **automated ad rotation and fatigue prediction**). Plus **Smartly Synapse** ("transforms planning, execution, and optimization"). ([smartly.io/products](https://www.smartly.io/products), [docs.smartly.io](https://docs.smartly.io/docs/introduction-to-smartly)) `[OFFICIAL]`

**Channels supported** (from their own docs, updated 2026-01-22): Google Ads, **Meta**, Pinterest, Snapchat, TikTok, YouTube (via DV360 and Google Ads), Reddit, **X (beta)**, **Amazon DSP (alpha)**, Spotify… plus Conversational Commerce, CTV ("200+ streaming services") and Open Web/DSPs.

**Pricing:** none published; `smartly.io/pricing` 404s. Historically a percentage-of-ad-spend platform fee. `[UNVERIFIED]` — do not quote a number.

**Useful engineering detail:** `docs.smartly.io` publishes an **`llms.txt`** index (`https://docs.smartly.io/llms.txt`) and every page offers "Copy as Markdown for LLMs / Open in Claude". The enterprise incumbent has already made itself agent-legible.

### 6.4 Hunch (hunchads.com)

*"Creative Performance Platform — Build, launch, learn. 10X FASTER."* Bridges creative, media and insights for **Meta, Snapchat, TikTok**. Core value is **enriched DPAs and CPVs** ("Supercharge catalogs across every ad account", "Localize across markets and channels in 10 minutes", "SKU level Insights"). Verticals: e-commerce, retail, travel, grocery, automotive, betting & gaming. Demo-only, no pricing. ([hunchads.com](https://hunchads.com/)) `[OFFICIAL]`

Reference case: localized creative for **4,000+ US locations** — *"Adding a dynamic field that allows the creative to feature the target market drastically reduced the rate of coupons claimed outside the target market."*

### 6.5 AdEspresso (Hootsuite) — alive, cheap, and stuck in 2019

Still operating. ([adespresso.com/pricing](https://adespresso.com/pricing/)) `[OFFICIAL]`

| Plan | $/mo | Spend limit | Notes |
|---|---|---|---|
| Starter | **$49** | **$1,000/month** | Unlimited ad accounts, Facebook & Instagram campaigns, essential features |
| Plus | **$99** | unlimited | Cross-campaign customized performance triggers, multi-page bulk creation, campaign approval, up to 15 seats, white-label reports |
| Enterprise | **from $259** | unlimited | Dedicated Facebook Marketing Consultant, ≥1h live training/mo, unlimited seats, **mandatory campaign approval**, **API access**, Salesforce contacts sync |

All plans: campaign import, automated post promotion, Inspector breakdown & split-testing analysis, automatic lead-campaign contact sync, tag-based aggregated reporting, schedulable reporting, customized performance triggers, "Automatic Optimization". 14-day trial.

Note the FAQ language, which is worth copying for any product that touches someone's ad account: *"all the Facebook advertising managed and created via AdEspresso will still be billed by Facebook… What you'll be paying us is the subscription for the use of the platform."*

**Read:** feature-frozen (still "Facebook Marketing Consultant" phrasing, still split-testing-centric). $49 with a $1,000 spend cap is the true floor price of Meta campaign automation.

### 6.6 Adzooma

Multi-platform PPC ops: Campaign Audit ("Instantly audit PPC accounts to spot wasted spend, disapprovals, and broken tracking"), Optimise & Improve, Scale Campaigns, Budget Tracking, Performance Scorecards (PPC/SEO/website), Automated Alerts, plus Google-heavy solution modules (Performance Max Toolkit, Shopping Ads Enhancer, RSA/Ad Copy Optimiser, conversion-tracking repair, audience expansion, ad extensions, targeting & bidding, ad scheduling). Meta is supported but is clearly the third channel behind Google and Microsoft. ([adzooma.com/pricing](https://adzooma.com/pricing/)) `[OFFICIAL]` Pricing did not render server-side. `[UNVERIFIED]`

### 6.7 Enhencer — an "AI agent" for Shopify e-commerce

*"Enhencer continuously analyzes your Meta and Google ads, **automatically generates stunning ad creatives**, and reaches high-intent customers… Our AI agent **takes actions and optimizes your ad campaigns 24/7** for maximum ROAS… Our New AI Agent **Eddy** automatically creates high-performing creatives and targets your ideal customers."* ([enhencer.com](https://enhencer.com/)) `[OFFICIAL]`

Features: **AI Traffic™** and **AI Remarketing Audiences** (automated targeting from prospecting to remarketing), *"Launch Fully Branded Catalogs Ads"* (turns the whole product catalog into creatives), catalog-driven video ads.

Case-study claims: 1.82x ROAS uplift / x4.58 revenue; 1.41x uplift / 44% lower CPR; 1.97x uplift / 55% lower CPR; 1.5x uplift / 27% lower CPR.

**Pricing:** no public pricing — `/pricing`, `/plans`, `/ai-ads` all 404. Sales motion is "Get Discovery Meeting". `[OFFICIAL]` (that the paths 404) / `[UNVERIFIED]` (price).

**Read:** on paper, Enhencer is the closest match to the target product for Shopify DTC: generate + target + optimise autonomously, 24/7, Meta + Google. Its narrow wedge (catalog/e-commerce, audience-first) and demo-only motion suggest limited self-serve autonomy in practice.

### 6.8 Enterprise creative automation / DCO

| Vendor | What it is | Evidence |
|---|---|---|
| **Celtra** ([celtra.com](https://celtra.com/)) | Creative Automation, **Dynamic Product Ads**, Creative Enablement (rich media/video), plus a media-owner side. Case: *"Nike Achieves 19.5% Higher Production Efficiency"* | `[OFFICIAL]` |
| **Storyteq** ([storyteq.com](https://storyteq.com/)) | "Content Marketing Platform": Content Portal, **Adaptation Studio** ("Instantly version content for every channel and market"), Collaboration Hub, AI for campaign rollout. Case: *"How Heineken cut content production costs by 40% while scaling to 160 countries."* | `[OFFICIAL]` |
| **Bannerflow** | Creative automation / display-first | site live, content not captured `[UNVERIFIED]` |
| **Skai** ([skai.io](https://www.skai.io)) | "AI-Powered Commerce Media Platform" — enterprise, retail-media-led | `[OFFICIAL]` (title only) |

**Note on the "Sitecore/Moveo-style enterprise DCO" prompt:** no live Sitecore or Moveo DCO product for Meta could be verified in this pass. The enterprise DCO tier that actually exists and sells is **Celtra / Storyteq / Bannerflow / Smartly Creative / Hunch**. `[UNVERIFIED]` for Sitecore/Moveo.

### 6.9 The graveyard — vendors that are gone, absorbed, or renamed

This matters: several names still circulate in "best Meta ads tools" listicles but are not viable references.

| Name | Status as of 2026-09-02 | Evidence |
|---|---|---|
| **Zalster** | **Dead.** `zalster.com` and `www.zalster.com` fail to connect entirely (no HTTP response) | `[OFFICIAL]` probe |
| **Trapica** | **Dormant.** `trapica.com` returns HTTP 200 with a ~4 KB near-empty page; no product content renders | `[OFFICIAL]` probe |
| **Consumer Acquisition** | **Absorbed.** Site is now a single redirect page: *"Consumer Acquisition is now part of **Brainlabs**"* — an agency, not a product | [consumeracquisition.com](https://www.consumeracquisition.com/) `[OFFICIAL]` |
| **Marin Software** | **Acquired.** Page title: *"Home - Marin Has Been Acquired by **Zax Capital**"* | [marinsoftware.com](https://www.marinsoftware.com) `[OFFICIAL]` |
| **Creatopy** | **Renamed.** `creatopy.com` → **thebrief.ai**, "Creatopy is now The Brief" | `[OFFICIAL]` |
| **vidyo.ai** | **Renamed.** `vidyo.ai` → **quso.ai**; `www.vidyo.ai` 404s | `[OFFICIAL]` |
| **AdCopy.ai** | **Gone.** `adcopy.ai` and `www.adcopy.ai` both return 404 | `[OFFICIAL]` |
| **pencil.ai** | Does not resolve; the live product is **trypencil.com** | `[OFFICIAL]` |

**Base rate to internalise:** of ~12 well-known Meta ad-automation brands from 2020-2023, **at least 7 are dead, renamed, or absorbed by 2026.** This is a category with severe mortality, driven by Meta absorbing the automation surface (see §3) and by trust collapse (see §9).

---

## 7. Open source

GitHub star counts read on 2026-09-02 via the GitHub API. `[OFFICIAL]`

| Repo | ★ | What it is |
|---|---|---|
| [pipeboard-co/meta-ads-mcp](https://github.com/pipeboard-co/meta-ads-mcp) | **1,226** | The category leader. MCP server that lets Claude/ChatGPT/Cursor *"run your Meta Ads end to end: launch campaigns, upload creatives, update budgets, and analyze performance."* Hosted **remote MCP**, no dev token, free plan. Meta node of Pipeboard's 5-platform family (Meta, Google, TikTok, Snap, Reddit) — **230+ tools**, one auth. Company is a **badged Meta Business Partner**. Also on PyPI as `meta-ads-mcp` 1.0.120 (2026-05-08) |
| [gomarble-ai/facebook-ads-mcp-server](https://github.com/gomarble-ai/facebook-ads-mcp-server) | 360 | Python MCP server for Facebook Ads |
| [proxy-intell/facebook-ads-library-mcp](https://github.com/proxy-intell/facebook-ads-library-mcp) | 295 | MCP over the **Facebook Ad Library** — competitive creative research |
| [RamsesAguirre777/facebook-ads-library-mcp](https://github.com/RamsesAguirre777/facebook-ads-library-mcp) | 229 | Self-hosted, **scrapes the public Ad Library with no API token** (advertiser, copy, landing pages, CTAs, any country) |
| [vishalgojha/social-flow](https://github.com/vishalgojha/social-flow) | 151 | TypeScript "guided control plane" for Meta ops — setup, daily execution, **approvals**, reporting, handoffs via commands, gateway APIs and an SDK |
| [mikusnuz/meta-ads-mcp](https://github.com/mikusnuz/meta-ads-mcp) | 72 | TS MCP server, **135 tools**, tracks **Marketing API v25→v26** (npm `@mikusnuz/meta-ads-mcp` 1.4.1, 2026-08-06) |
| [EfrainTorres/armavita-meta-ads-mcp](https://github.com/EfrainTorres/armavita-meta-ads-mcp) | 51 | Python MCP with **token redaction**, cursor pagination, campaigns/adsets/ads/creatives/insights/reports |
| [itallstartedwithaidea/advertising-hub](https://github.com/itallstartedwithaidea/advertising-hub) | 38 | *"Open-source one-stop shop for advertising platform APIs, MCP servers, AI agents, and PPC automation. 14 platforms… 25+ AI agents."* |
| [attainmentlabs/meta-ads-cli](https://github.com/attainmentlabs/meta-ads-cli) | 34 | **YAML → campaign** CLI (`meta-ads create --config campaign.yaml`), validate + `--dry-run` + audit logs |
| [oliverames/meta-mcp-server](https://github.com/oliverames/meta-mcp-server) | 31 | **200+ tools** across Pages, Instagram, Threads, Ads Manager, Commerce, **Conversions API**, Audiences, Insights, Ad Library |
| [Awaisali36/FaceBook-Ad-Manager-System](https://github.com/Awaisali36/FaceBook-Ad-Manager-System) | 26 | n8n + Claude + Gemini + Airtable workflow that *"generates production-ready Facebook ads in minutes"* |
| [fivetran/dbt_facebook_ads](https://github.com/fivetran/dbt_facebook_ads) | 52 | dbt models for Facebook Ads (warehouse modelling, not automation) |

**The `meta-ads-cli` README contains the most important sentence in open source right now** `[OFFICIAL]`:

> "This is an early independent open source Meta Ads CLI, first published in February 2026 **before Meta later introduced its official Ads AI Connectors and Ads CLI**. Use Meta's official connector if you want Meta-hosted OAuth and first-party support."

It also documents the safety default every autonomous system should copy:

> "Your campaign is created as **PAUSED by default**. Review it in Ads Manager, then act…"

**What open source does NOT have:** there is **no open-source project that closes the loop.** Every repo is either (a) an API/MCP wrapper, (b) an Ad Library scraper, or (c) a warehouse model. None generates creative, publishes it, measures it, and feeds the measurement back into the next generation. The closest is `Awaisali36/FaceBook-Ad-Manager-System` (26 stars, n8n glue) and it is a generation pipeline, not a loop.

npm ecosystem for completeness: `@cesteral/meta-mcp` 1.3.0 (2026-06-10, defaults to v25), `@channel47/meta-ads-mcp` 1.0.0 (2026-07-11), `meta-ads-mcp-server` 1.5.1 (2026-05-25), `@getscaleforge/mcp-meta-ads` 0.2.3 (2026-04-17), `metaadskill` 1.0.0 (2026-07-22).

---

## 8. Who actually closes the loop? A ranked, sceptical assessment

The loop is: **generate → publish → measure → attribute → learn → generate better**, with no human in the seat.

| Rank | Vendor | Generate | Publish to Meta | Measure | Act on measurement | Feed back into generation | Human required? |
|---|---|---|---|---|---|---|---|
| 1 | **Creatify** | ✅ video + static | ✅ **Ad Launcher (Meta/TikTok/AppLovin)** | ✅ Ad Insights (spend/ROAS/CTR per creative) | ✅ **AI Performance Agent** | ⚠️ claimed ("know which hooks convert"), unproven | Yes — to approve/select |
| 2 | **Omneky** | ✅ image/video/copy, Brand LLM | ✅ Campaign Launcher, "Approve & Launch" | ✅ Omnichannel Insights | ⚠️ "Smart Ads — automate ad creation with AI **and performance data**" | ⚠️ claimed | **Yes — the module is literally named "Approve & Launch"** |
| 3 | **Enhencer** | ✅ catalog creatives + video | ✅ (implied — it runs the campaigns) | ✅ continuous | ✅ *"AI agent takes actions… 24/7"* | ⚠️ claimed | Unclear; demo-gated |
| 4 | **Segwise** | ✅ statics/video/playables from winning patterns | ⚠️ not stated | ✅ tagging + fatigue | ⚠️ advisory | ✅ **explicitly the design** ("Learns from what goes live → Repeats") | Yes — to ship |
| 5 | **Atria** | ✅ images, scripts, copy, ad clones | ✅ **"One-click bulk upload directly to Meta"** | ✅ Radar 24/7 | ✅ "auto-scale winners, auto-pause losers" | ⚠️ "Data-driven briefs built from your own ad performance" | **Yes — "one-click"** |
| 6 | **Madgicx** | ✅ AI Ads | ✅ "Automated Ad Launch Tool" | ✅ AI Ad Analyzer | ✅ rules + AI Marketer | ❌ | Yes — AI Marketer "tells you what to do next" |
| 7 | **Motion (Growth tier)** | ⚠️ briefs/hooks, not finished assets | ⚠️ via bespoke pipelines | ✅ best-in-class | ✅ Routines/alerts | ✅ **"Closed-loop pipelines… signal to launched ad"** | **Yes — sold as services at >$125k/mo spend** |
| 8 | **Metadata.io** (B2B) | ✅ creative + offers | ✅ multi-channel execution engine + **MCP / headless** | ✅ leads→pipeline→revenue | ✅ | ⚠️ | **Yes, by design and stated policy** |
| 9 | **Smartly** | ✅ Gen-AI creative at scale | ✅ | ✅ Intelligence suite, **fatigue prediction**, automated ad rotation | ✅ predictive bid/budget | ⚠️ | Yes — enterprise workflow |
| — | **Revealbot/Bïrch, Hunch, AdEspresso, Adzooma, Celtra, Storyteq** | ❌/partial | ✅ | ✅ | ✅ rules | ❌ | Yes |
| — | **Motion, Foreplay, Superads, VidMob, Neurons** | ❌ | ❌ | ✅ | ❌ | ❌ (advisory) | Yes |
| — | **AdCreative.ai, Arcads, HeyGen, Synthesia, Captions, MakeUGC, TopView, Higgsfield** | ✅ | ❌ | ❌ | ❌ | ❌ | Yes |
| — | **Icon** | ✅ (humans) | ⚠️ Admaker 2.0 console | ✅ | ❌ | ✅ (human creative directors) | Yes, entirely |

**Verdict: nobody verifiably closes it unattended.**

The strongest claims decompose into one of three patterns:
1. **"One-click" / "Approve & Launch"** — a human is the gate (Atria, Omneky).
2. **"Tells you exactly what to do next"** — an advisor, not an operator (Madgicx AI Marketer, Motion, Runneth, Atria Radar).
3. **"Closed-loop pipelines built with you"** — a services engagement, not a product (Motion Growth).

Metadata.io deserves credit for stating the constraint plainly rather than marketing around it: *"Your team reviews budget, approvals, channel structure, and pipeline evidence **before anything goes live**."* That is the honest state of the art in 2026.

---

## 9. The recurring, unsolved complaints

Aggregated from Trustpilot distributions read on 2026-09-02. `[SECONDARY]`

| Vendor | TrustScore | Reviews | % 1-star | Dominant complaint |
|---|---|---|---|---|
| **Madgicx** | **1.7** | 271 | **46%** | Trial→charge, cancellation friction, refund refusal |
| **Arcads** | **2.7** | 170 | **46%** | Output quality vs. marketing; support silence (23 days) |
| **Omneky** | **2.9** | 45 | **47%** | Unauthorised charges; "poorly designed AI with nice packaging" |
| **AdCreative.ai** | **3.4** | 4,488 | **33%** | Post-trial charges; refunds promised then delayed |
| **Revealbot/Bïrch** | 3.8 | 18 | 28% | Overage billing; reliability ("couldn't launch the creatives") |
| **Icon** | 4.0 | 75 | 34% | Cancellation UX; product-in-flux |
| **Creatify** | 4.0 | 824 | 16% | Hidden credit consumption; prompt-adherence failures |

### The five complaints that repeat everywhere

1. **Output that doesn't survive contact with a real brand.** *"All scenes are messed up, language is absolutely different than the language i wrote in the prompt"* (Creatify). *"Videos produced look NOTHING like their ads - glitchy/not lip synced & clearly AI"* (Arcads). **Prompt adherence and product fidelity are the #1 product failure**, not aesthetics. If your system autonomously spends money on an ad that shows the wrong product, the wrong language, or a mangled logo, the loop is worse than useless — it is negatively valuable.
2. **Credit systems that make unit cost unknowable.** *"150-200 credits doesn't even give you a usable result… you are paying around $50 for a sub standard AI generated video."* (Creatify). *"They charged me $588 for an annual plan but completely hide their credit consumption."* Every major vendor meters on credits **and** ad spend **and** seats simultaneously (Atria meters all three). Buyers cannot forecast cost, so they churn.
3. **Billing as the business model.** The bimodal 50/46 and 55/33 star splits are the signature of a company whose revenue depends on failed cancellations, not retention. **This is the category's single biggest reputational liability and the clearest positioning opportunity.**
4. **No real learning.** Not one vendor publishes evidence that generation N+1 is better than generation N *because of* measured performance. The claims are all structural ("trained on $9B/$35B in ad spend") rather than per-account and closed-loop. Segwise is the only one to *state* the loop as its architecture.
5. **Still needs an operator.** Bïrch's own testimonial is the tell: automation cut an 8-hour day to 1–2 hours — of *creative work*. Nobody got to zero.

### Two complaints that are conspicuously absent from the public record

- **Policy rejections.** No vendor markets a solution for automated recovery from Meta ad rejections, and no review corpus surfaced it as a solved problem. The only related product in the whole sweep is AdCreative.ai's **"Compliance Checker — Check ads for brand, platform & policy compliance, avoid violations"** (pre-flight, advisory). For an unattended system this is an existential gap: a rejection at 03:00 with no human on call halts the loop, and repeated rejections risk account restriction. `[UNVERIFIED]` that anyone handles this autonomously.
- **Learning-phase / statistical-significance discipline.** Nobody advertises "we won't kill an ad set before it exits learning." Rules engines (Bïrch, Madgicx, AdEspresso "performance triggers") act on thresholds, which is exactly how you destroy a campaign that would have converged.

---

## 10. Meta's encroachment and the defensible surface area

**What Meta gives away free, today:**

| Meta capability | Kills / commoditises |
|---|---|
| Advantage+ automated audience, placement, budget allocation | Trapica, Zalster, Enhencer's audience wedge, most of "AI targeting" |
| `degrees_of_freedom_spec` creative transformations on the AdCreative object | "auto-resize / auto-variant" features across Layer 1 |
| `asset_feed_spec` Dynamic Creative + asset customization rules | basic multivariate testing (Marpipe's original wedge) |
| `generative_asset_spec` / `AdCreativeGenerativeAssetSpec` | native generative creative, in the ad object itself |
| `contextual_multi_ads` | contextual multi-ad orchestration |
| Advantage+ catalog ads | DPA tooling's floor |
| **Ads CLI (`pip install meta-ads`) + Ads AI Connectors** | the entire "we wrap the Marketing API for agents" thesis — including most of §7's open source |
| Meta subsidising **Marpipe** for qualified brands | signals which third-party value Meta *wants* (feed/catalog quality) |

**What Meta structurally will not do:**

1. **Produce your creative from your product reality.** Meta can restyle, expand, animate and recombine assets you supply. It has no access to your product's physical truth, your customer reviews, your returns data, your landing pages, or your brand's non-negotiables. Every serious vendor's differentiation now routes through this (Atria "customer review mining into ad angles"; Pencil brand governance; Icon's whole business).
2. **Optimise across platforms.** Meta optimises Meta.
3. **Own your measurement.** Meta's attribution favours Meta. This is why Motion sells **Northbeam** integration, Bïrch sells **Hyros/Wicked Reports/AppsFlyer**, Madgicx sells **Tracking Pro ($49/mo, server-to-server, Facebook Click ID)**, and Prescient AI sells MMM. **The independent measurement substrate is the most defensible layer left**, because it is the only thing Meta is structurally disqualified from providing.
4. **Take responsibility for a business outcome.** Advantage+ optimises what you tell it to optimise. It will not decide that your $2,000/mo budget should go to a different product, a different offer, or no ads at all.

**Blunt conclusion:** *campaign mechanics are no longer defensible.* Bidding, budgeting, placement, audience expansion and even creative variation have been absorbed. What remains defensible is **(a) creative that is *true about the product*, (b) measurement Meta cannot mark its own homework on, and (c) the judgement layer that decides what to make next.**

---

## 11. Where the genuine gap is — stated plainly

**Everything on the shelf is a component. Nobody sells the machine.**

1. **The unattended gap.** Every product in this document requires a human to click *launch*, *approve*, or *select*. The word "one-click" appears as a *feature* in Atria's competitive grid — meaning the industry's best-in-class is "a human clicks once." A system where the human's only recurring action is reading a weekly summary does not exist commercially. This is the actual product gap.
2. **The learning gap.** Vendors train on aggregate corpora ($35B, $9B, "30M ads analyzed"). Nobody demonstrably runs a **per-account** loop where *this brand's* measured results change *this brand's* next creative brief. Segwise names the loop; Motion sells it as consulting; nobody productises it.
3. **The failure-handling gap.** Policy rejections, learning-phase resets, ad-account restrictions, creative fatigue, seasonality shifts, and attribution lag are the reasons a human is still in the seat. No vendor markets autonomous handling of any of them. **This — not creative quality — is the real reason full autonomy doesn't exist.** An autonomous system is defined by what it does when things go wrong at 3am, and that is entirely unclaimed territory.
4. **The fidelity gap.** The loudest customer complaint across every AI creative tool is that the output misrepresents the product. Icon's pivot from "The AI Admaker" to human UGC is the market's verdict. **Any autonomous system must solve product fidelity *before* it earns the right to spend unattended** — because the cost of an unattended wrong-product ad is not a wasted render, it is wasted media plus brand damage.
5. **The trust gap.** The two loudest vendors in the category (Madgicx 1.7/5, AdCreative.ai 3.4/5 with 33% one-star) have monetised cancellation friction. A product that takes a customer's ad account credentials and spends their money has to be *radically* more trustworthy than the incumbents — transparent unit economics, hard spend caps, one-click kill switch, no dark-pattern billing. This is cheap to build and is currently a wide-open positioning.

**What is NOT the gap** (do not build a moat here):
- Wrapping the Marketing API — Meta ships `meta-ads` free, and there are 10+ open-source MCP servers.
- Generating AI video — HeyGen/Synthesia/Higgsfield/Arcads/Captions are commodity suppliers at $25–$99/mo.
- Rules engines — Bïrch does this for $99/mo with 15,000 clients.
- Dashboards and creative tagging — Motion, Foreplay, Atria, Superads, Segwise, VidMob all do it, several with MCP, and customers like them.

---

## 12. Gotchas

1. **Meta ships its own CLI now.** `pip install meta-ads`, v1.1.0, "Official CLI for the Meta Marketing API", first released **2026-04-29**. If your pitch is "agent-controllable Meta ads", Meta already gave that away in April. Differentiate above it, not on it. ([PyPI](https://pypi.org/project/meta-ads/))
2. **Meta's dev-doc URLs moved.** `/docs/marketing-api/...` → `/documentation/ads-commerce/marketing-api/...`. Old deep links 404 (`/docs/marketing-api/generative-ai/`, `/docs/marketing-api/advantage-plus-creative`). Any scraped doc index built before mid-2026 is stale.
3. **Docs lag the SDK by a version.** SDK is `facebook-business` **26.0.1** (2026-08-25) but live doc samples still show `graph.facebook.com/**v25.0**/act_<ID>/adcreatives`. Pin explicitly; don't infer the version from prose docs.
4. **`asset_feed_spec` is nearly immutable.** You **cannot convert between ad format types** and **cannot remove `asset_feed_spec`** on update. Asset customization rules require **≥2 rules**, and Dynamic Creative feeds must contain **no** customization rules. Design your creative pipeline to create-new, never mutate.
5. **Budgets are in minor units.** Meta's own CLI example is `--daily-budget 5000` = $50.00. Every off-by-100 bug in this category comes from here.
6. **Objectives are ODAX.** Meta's example uses `--objective OUTCOME_SALES`, not the legacy `CONVERSIONS`.
7. **Meta requires a *system user* token, not a user token.** Scopes: `business_management`, `ads_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, `catalog_management`, `read_insights`. The system user must be an **admin** system user *and* added as **App Admin** in Meta for Developers, with each asset (ad account, Page, dataset, catalog) individually assigned. Miss one assignment and you get opaque permission errors.
8. **Create campaigns PAUSED.** The most-adopted open-source CLI defaults to it: *"Your campaign is created as PAUSED by default."* Copy this default; make going live an explicit, logged transition.
9. **Vendor pricing is deliberately unknowable — plan for competitive opacity.** Arcads has **no pricing page at all** (`/pricing` 404s, plans visible only after signup). Madgicx renders **"See price inside the app"** with `$0/mo`. Smartly, Hunch, Enhencer, Omneky and VidMob publish nothing. You cannot build a reliable price-comparison feature, and you should assume competitors will not publish prices to compare against yours either.
10. **Spend-banded pricing has overage teeth.** Bïrch: *"Overages of X% apply if ad spend limit is exceeded."* Superads: +$100/mo per extra $100k spend. Motion: $750 → $1,200 at the $50k line. If you price on ad spend, you must reconcile Meta-reported spend against your own meter or you will bill wrong.
11. **Trials disable production automation on expiry.** Bïrch: *"Once your trial expires, your automated rules and reports **will be disabled**."* If you integrate a third-party rules engine, its trial state can silently stop your loop.
12. **Meta subsidises specific partners.** Marpipe's banner: *"Meta Partnership to subsidize cost of Marpipe for qualified brands."* A competitor whose price Meta partially pays is not competing on the same cost base as you.
13. **Review sites are hard-blocked; Trustpilot is not.** G2, Capterra, ProductHunt and Reddit all return 403 to programmatic clients. Trustpilot is readable through a rendering fetcher and is by far the best free source of vendor weakness data.
14. **Bimodal star distributions mean billing, not product.** 50%/46% (Madgicx) and 55%/33% (AdCreative.ai) five-star/one-star splits are the fingerprint of subscription-trap monetisation. Read the 1-star text before believing a headline score.
15. **The "AI creative wins" assumption is contested by the best-funded player.** Icon raised $30M+ to build "The AI Admaker" and now sells **"6 Human UGC ads filmed & edited for $1000 (no AI / 100% real)"**. Whatever you build must have an answer for why AI creative clears the DTC performance bar when Icon concluded it didn't.
16. **MCP is already table stakes, not a differentiator.** Creatify, Foreplay, Atria, Motion, Bïrch, Omneky, Metadata.io and Higgsfield all ship MCP servers, plus 10+ open-source ones — and Meta appears to ship its own. Shipping an MCP server buys you nothing competitively in 2026.
17. **`facebook-business` PyPI JSON sorts releases lexicographically.** `sorted(releases)` puts `"10.0.0"` before `"2.0.0"` and will give you a wrong "latest release date". Sort by parsed integer tuples.

---

## 13. Open questions / UNVERIFIED

1. **Does Meta ship an official MCP server?** Bïrch's docs nav references a prompting guide covering *"Birch AI, **Meta MCP** and Birch MCP"*, and Meta's docs section is named "Ads AI **Connectors**" (plural, with the CLI as one child). Meta's own MCP page could not be retrieved. **High priority to confirm** — it materially affects architecture. `[UNVERIFIED]`
2. **`AdCreativeGenerativeAssetSpec` field list.** The type is referenced on the AdCreative reference page; its own reference page truncated before the field table rendered. Need: field names, types, allowed enum values, and whether it accepts caller-supplied generative instructions or is Meta-controlled. `[UNVERIFIED]`
3. **The current Advantage+ product taxonomy and the exact `degrees_of_freedom_spec` enum values.** Meta's business pages are login-walled and the old `advantage-plus-creative` doc path 404s. Need the exact names of the generative enhancements (text generation / image expansion / background generation / image animation / etc.), which are free, which are default-on, and how each maps to a `degrees_of_freedom_spec` key. `[UNVERIFIED]`
4. **Whether any vendor autonomously handles ad policy rejections.** Nothing in this sweep claims it. Worth a targeted second pass on Smartly, Hunch and Enhencer docs. `[UNVERIFIED]`
5. **Funding and revenue for the 2024-26 entrants** (Creatify, Atria, Superads, Segwise, Arcads, Motion, Foreplay). Crunchbase/PitchBook are paywalled and the available search index returned no usable results. Only Icon's self-reported "$30M+ raised, Founders Fund, 68 investors" was obtainable. `[UNVERIFIED]`
6. **Smartly's pricing model.** Historically a % of ad spend; no current figure obtainable. `[UNVERIFIED]`
7. **Enhencer, Omneky, Hunch, VidMob, Adzooma pricing.** All demo-gated or client-rendered. `[UNVERIFIED]`
8. **"Sitecore/Moveo-style enterprise DCO."** No live Sitecore or Moveo DCO product for Meta was found. Either the reference is to a different product name or it has been discontinued. `[UNVERIFIED]`
9. **Whether Creatify's "AI Performance Agent" actually changes budgets/status autonomously**, or only recommends. The pricing matrix lists it as a feature; no doc describes its authority. `[UNVERIFIED]`
10. **Trapica's actual status** — 200 OK with an empty body could be a rebuild rather than a shutdown. `[UNVERIFIED]`
11. **OpenAI Ads as a channel.** Omneky lists it alongside Google/Meta/TikTok/LinkedIn/Reddit. If a real ad surface exists there, it changes the multi-channel roadmap. `[UNVERIFIED]`
12. **Meta's stated end-state for AI-generated ads.** Widely reported executive statements about businesses supplying only an objective and a payment method could not be sourced to a first-party Meta page in this pass. Do not quote it without a primary source. `[UNVERIFIED]`

---

## 14. Source index

**Meta / official**
- Ads CLI overview — https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-cli/ads-cli-overview
- Ads CLI get started — https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-cli/setup/get-started
- Ads CLI tutorials & recipes — https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-cli/tutorials-and-recipes
- AdCreative reference — https://developers.facebook.com/docs/marketing-api/reference/ad-creative/
- asset_feed_spec — https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/asset-feed-spec
- Advantage+ catalog ads — https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads
- PyPI `meta-ads` — https://pypi.org/project/meta-ads/
- PyPI `facebook-business` — https://pypi.org/project/facebook-business/

**Creative generation**
- https://www.adcreative.ai/ · https://creatify.ai/pricing · https://creatify.ai/ · https://www.arcads.ai/ · https://arcads.live/ · https://icon.com/ · https://www.omneky.com/ · https://trypencil.com/ · https://www.thebrief.ai/ · https://www.thebrief.ai/pricing · https://www.heygen.com/pricing · https://www.synthesia.io/pricing · https://captions.ai/pricing · https://www.opus.pro/pricing · https://quso.ai/ · https://www.makeugc.ai/ · https://www.topview.ai · https://higgsfield.ai/

**Creative analytics**
- https://motionapp.com/pricing · https://runneth.com · https://www.foreplay.co/pricing · https://www.tryatria.com/ · https://www.tryatria.com/pricing · https://superads.ai/pricing · https://vidmob.com/product · https://www.neuronsinc.com · https://www.segwise.ai · https://www.marpipe.com/pricing

**Campaign automation / DCO**
- https://revealbot.com/pricing · https://madgicx.com/pricing · https://madgicx.com/ · https://www.smartly.io/products · https://docs.smartly.io/docs/introduction-to-smartly · https://docs.smartly.io/llms.txt · https://hunchads.com/ · https://adespresso.com/pricing/ · https://adzooma.com/pricing/ · https://enhencer.com/ · https://celtra.com/ · https://storyteq.com/ · https://www.skai.io · https://metadata.io

**Status changes**
- https://www.consumeracquisition.com/ (→ Brainlabs) · https://www.marinsoftware.com (→ Zax Capital) · creatopy.com → thebrief.ai · vidyo.ai → quso.ai

**Reviews (weaknesses)**
- https://www.trustpilot.com/review/madgicx.com · /adcreative.ai · /creatify.ai · /arcads.ai · /omneky.com · /revealbot.com · /icon.com

**Open source**
- https://github.com/pipeboard-co/meta-ads-mcp · /gomarble-ai/facebook-ads-mcp-server · /proxy-intell/facebook-ads-library-mcp · /RamsesAguirre777/facebook-ads-library-mcp · /vishalgojha/social-flow · /mikusnuz/meta-ads-mcp · /EfrainTorres/armavita-meta-ads-mcp · /itallstartedwithaidea/advertising-hub · /attainmentlabs/meta-ads-cli · /oliverames/meta-mcp-server · /Awaisali36/FaceBook-Ad-Manager-System · /krusemediallc/arcads-claude-code

**Third-party pricing analysis**
- https://www.wireflow.ai/blog/arcads-pricing (2026-07-14)
