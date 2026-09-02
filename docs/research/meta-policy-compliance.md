# Meta Ad Policy, AI-Content Disclosure & Account Safety

**Research date: 2026-09-02.** Target: a fully autonomous publisher that generates video creative with AI and pushes it to live Meta ad accounts via Marketing API **v26.0** (version per sibling doc `meta-api-foundations.md`) with no human in the loop.

Confidence tags used throughout: **[OFFICIAL]** = Meta / EU / FTC primary source fetched directly; **[OFFICIAL-IDX]** = official URL, content surfaced via search index rather than a direct successful fetch (Meta's `facebook.com/business/help/*` pages are JS-gated and frequently un-fetchable); **[SDK]** = read out of Meta's own auto-generated `facebook-python-business-sdk` source, which is codegen'd from the same schema that serves the Graph API; **[2ND]** = secondary source; **[UNVERIFIED]** = could not confirm, do not build load-bearing logic on it.

---

## 0. The five facts that should shape the architecture

1. **There is no blanket "you must declare AI" checkbox for ordinary ads.** As of today, Meta requires *advertiser* disclosure of generative-AI media **only for ads about Social Issues, Elections or Politics (SIEP)**, and only in five enumerated deception scenarios. For every other ad, Meta labels *on its own detection* ("AI info" in **About this ad**), with automated third-party-AI detection announced but **not confirmed live** — see the fact-check log; ~~live since 2026-06-01~~ was an over-read of a page timestamp. A large volume of 2026 SEO blog content claims Meta made AI disclosure mandatory for all advertisers and that "Undisclosed AI Content" is the #3 rejection reason at 14% of rejections. **Those blogs contradict Meta's own current documentation and I found no primary source for them. Trust the docs.** (§4)
2. **The pre-flight hook you want already exists and is barely documented:** `POST /act_<ID>/ads` with `execution_options=['validate_only','synchronous_ad_review']` runs *Ads Integrity validations* — "message language checking, image 20% text rule, and so on" — **without creating the ad**. This is the only first-party policy oracle available before spend. (§3.6)
3. **Disapproval is machine-readable, but the taxonomy is not documented.** `Ad.effective_status = DISAPPROVED` plus `ad_review_feedback.global` (a `map<string,string>` of *undocumented* reason-code → human sentence) plus `issues_info[]` (`error_code`, `error_type` ∈ {`HARD_ERROR`,`SOFT_ERROR`}). You must build and maintain your own reason-code registry by observation. (§3.2–§3.4)
4. **The account-safety threat model is not "an ad gets rejected"; it is "the Business Account gets restricted."** Meta's ad standards contain a whole section — *Advertising Policies Affecting Business Assets* (Account Integrity, Inauthentic Behavior, Cybersecurity, Spam, User Requests) — that governs *behavior*, not creative. Meta is simultaneously expanding mandatory advertiser verification with the stated goal that "verified advertisers drive 90% of our ads revenue by the end of 2026, up from 70% today," and in Feb 2026 sent cease-and-desist letters to eight consultants selling "un-ban" services and account rental. A high-volume automated publisher sits squarely in the risk surface. (§8)
5. **There is no appeals API.** The `Ad` node has exactly eight edges and none of them is an appeal. Re-review is triggered by *editing the ad* — and editing is also a "significant edit" that can reset the ad set's learning phase. Your remediation loop must therefore prefer *new ad in same ad set* over *edit existing ad*. (§9)

---

## 1. Meta Advertising Standards — complete structure as of 2026-09-02

Source of truth: <https://transparency.meta.com/policies/ad-standards/> **[OFFICIAL]**. This is the *current* taxonomy; older URL shapes (`/policies/ad-standards/prohibited-content/…`, `/policies/ad-standards/deceptive-content/…`, `facebook.com/policies/ads/…`) still appear in search indexes and in most third-party guides but 404 or redirect. **Hard-code nothing against those paths.**

There is no formal "Prohibited vs Restricted" top-level split any more. **Fact-check correction (2026-09-02): the index page carries sixteen top-level headings, not ten.** The ten *policy* sections below are the ones with enforceable rules; the other six are Overview, "Meta advertising policy principles", "The ad review process", "What to do if your ad is rejected or if your business asset is restricted", "Things you should know", and — **materially, and missed entirely below** — **"Transparency requirements under the EU Digital Services Act"** (see the new §5.7). The ten policy sections are:

### 1.1 Community Standards
- `/policies/ad-standards/community-standards/` — *"Content must comply with the Community Standards and Instagram Community Guidelines in order to be eligible to be run in an ad."* An ad inherits the entire Community Standards surface on top of the ad-specific rules.

### 1.2 Unacceptable Content
| Policy | URL path |
|---|---|
| Child Sexual Exploitation, Abuse, and Nudity | `/policies/ad-standards/objectionable-content/child-sexual-exploitation-abuse-nudity/` |
| Coordinating Harm and Promoting Crime | `/policies/ad-standards/unacceptable-content/coordinating-harm-and-promoting-crime/` |
| Dangerous Organizations and Individuals | `/policies/ad-standards/unacceptable-content/dangerous-orgs-individuals/` |
| Discriminatory Practices | `/policies/ad-standards/unacceptable-content/discriminatory-practices/` |
| Hateful Conduct | `/policies/ad-standards/unacceptable-content/hateful-conduct/` |
| Human Exploitation | `/policies/ad-standards/unacceptable-content/human-exploitation/` |
| Locally Illegal Content, Products or Services | `/policies/ad-standards/unacceptable-content/locally-illegal-products-services/` |
| Misinformation | `/policies/ad-standards/unacceptable-content/misinformation/` |
| Vaccine Discouragement | `/policies/ad-standards/unacceptable-content/vaccine-discouragement/` |

### 1.3 Fraud, Scams, and Deceptive Practices
- Fraud, Scams and Deceptive Practices — `/policies/ad-standards/fraud-scams/fraud-scams-deceptive-practices/`
- Unacceptable Business Practices — `/policies/ad-standards/fraud-scams/unacceptable-business-practices/`

### 1.4 Restricted Goods and Services
Alcohol · Commercial Exploitation of Crises and Controversial Events · Dating Ads · Hazardous Goods and Materials · **Health and Wellness** · Historical Artifacts · Sale of Human Body Parts and Bodily Fluids · Sale of Non-Endangered Animals and Endangered Species · Tobacco and Related Products · Weapons, Ammunition or Explosives · Drugs and Pharmaceuticals · Drug and Alcohol Addiction Treatment · **Financial and Insurance Products and Services** · **Cryptocurrency Products and Services** · Online Gambling and Games. (All under `/policies/ad-standards/restricted-goods-services/…`.)

### 1.5 Objectionable Content
Adult Nudity and Sexual Activity · Adult Sexual Exploitation · Adult Sexual Solicitation and Sexually Explicit Language · Bullying and Harassment · Profanity · **Privacy Violations and Personal Attributes** · Violent and Graphic Content · Suicide, Self-Injury, and Eating Disorders. (All under `/policies/ad-standards/objectionable-content/…`.)

### 1.6 Intellectual Property Infringement
- Third-Party Intellectual Property Infringement — `/policies/ad-standards/intellectual-property-infringement/third-party-infringement/`
- Using Meta Intellectual Property Licenses — `/policies/ad-standards/intellectual-property-infringement/Using-Meta-Intellectual-Property-Licenses/` (note the capitalised path segment — Meta's own URL)

### 1.7 Social Issue, Electoral or Political Advertising
- Ads about Social Issues, Elections or Politics — `/policies/ad-standards/SIEP-advertising/SIEP/`

### 1.8 Product and Format-Specific Policies
**These five have no separate URLs — they are inline sections of the `/policies/ad-standards/` index page.** A scraper that crawls only the linked sub-pages will silently miss all of them.
- **Video Ads:** *"Videos and other similar ad types must not use overly disruptive tactics, such as flashing screens."*
- **Lead Ads**
- **Targeting:** advertisers may not *"use targeting options to discriminate against, harass, provoke, or disparage people or to engage in predatory advertising practices."*
- **Relevance:** all ad components *"must be relevant to the product or service being offered"* and *"must clearly represent the company, product, service, or brand that is being advertised."* **This section carries the landing-page-match rule:** *"The products and services promoted in an ad must match those promoted on the landing page."*
- **Branded Content:** when promoting branded-content integrations, *"advertisers must use the branded content tool"* to tag the third-party partner.

### 1.9 Advertising Policies Affecting Business Assets
| Policy | URL path |
|---|---|
| Account Integrity | `/policies/ad-standards/business-assets/account-integrity/` |
| Inauthentic Behavior | `/policies/ad-standards/business-assets/inauthentic-behavior/` |
| Cybersecurity | `/policies/ad-standards/business-assets/Cybersecurity/` |
| Spam | `/policies/ad-standards/business-assets/spam/` |
| User Requests | `/policies/ad-standards/business-assets/user-requests/` |

**Crawler warning (fact-check 2026-09-02):** these five ad-standards pages are **one-sentence pointers**, not policy text. `/business-assets/account-integrity/` says only *"Business assets must comply with the Community Standard on Account Integrity."* The substantive language a classifier needs lives at `transparency.meta.com/policies/community-standards/{account-integrity, spam, inauthentic-behavior, cybersecurity}`. A policy-monitoring crawler pointed at the ad-standards paths will diff one sentence per policy and see nothing when the real rule changes. **Crawl the Community Standards, not the ad-standards stubs, for §1.9.**

### 1.10 Data Use Restrictions

**Engineering consequence:** the policy taxonomy is ~45 named policies in 10 sections. Your pre-flight classifier (§11.1) should emit a label drawn from *this* namespace, not from a bespoke one — because when a disapproval arrives you will want to reconcile `ad_review_feedback` reason codes against the same namespace.

---

## 2. The review process: what actually happens between `POST /ads` and delivery

### 2.1 Timing and mechanics **[OFFICIAL]**
From `/policies/ad-standards/`:
- *"Our ad review process starts automatically before ads begin running, and is typically completed within 24 hours, although it may take longer in some cases."*
- Scope: *"This review process may include the specific components of an ad, such as images, video, text and targeting information, as well as an ad's associated landing page or other destinations."*
- Mechanism: Meta uses **automated review and, in some instances, manual review**.
- *"Ads remain subject to review and re-review at all times, and may be rejected or restricted for violation of our policies at any time."* — i.e. approval is **not** terminal. An ad that ran for three weeks can be pulled.
- Separate track: Meta *"also monitor[s] and investigate[s] advertiser behavior, and may restrict advertiser accounts."*
- Soft enforcement: *"Lower quality ads which do not necessarily violate our policies may experience impacted performance."* There is **no API signal** for this. It manifests only as bad delivery. (See §6.7 and §11.1.)

### 2.2 What "in review" means for delivery
- New ads do **not** deliver during review. Meta's Ad reference: *"New ads are in pending state and do not run until Facebook approves or rejects them."* **[OFFICIAL]**
- `effective_status = PENDING_REVIEW` → not delivering.
- `effective_status = PREAPPROVED` → reviewed and cleared but not yet in its scheduled flight (typical for ads created with a future `start_time`).
- Re-review after an edit: **[OFFICIAL, upgraded 2026-09-02]** the ad-standards index is unambiguous — edited ads *"will be treated as new ads and reviewed by our ad review system."* <https://transparency.meta.com/policies/ad-standards/>. Whether the ad keeps delivering during that re-review is still **[UNVERIFIED]** (the learning-phase help page <https://www.facebook.com/business/help/316478108955072> is JS-gated and could not be read); instrument it.
- Re-review after a rejection appeal is *"usually completed in 24 hours, although it can take longer."* **[OFFICIAL-IDX]**
- Business-asset restriction reviews: *"typically the review is completed in 48 hours."* **[OFFICIAL-IDX]** <https://www.facebook.com/business/help/530209463124901>

### 2.3 Full `effective_status` enum — Ad level **[SDK]**
From `facebook_business/adobjects/ad.py`, `class EffectiveStatus`:

```
ACTIVE, ADSET_PAUSED, ARCHIVED, CAMPAIGN_PAUSED, DELETED, DISAPPROVED,
IN_PROCESS, PAUSED, PENDING_BILLING_INFO, PENDING_REVIEW, PREAPPROVED, WITH_ISSUES
```

`class Status` (the *settable* one) is only `ACTIVE, ARCHIVED, DELETED, PAUSED`. `configured_status` is the deprecated alias of `status`.

**Gotcha:** `DISAPPROVED` exists **only at the ad level**. Ad set `effective_status` is `{ACTIVE, PAUSED, DELETED, CAMPAIGN_PAUSED, ARCHIVED, IN_PROCESS, WITH_ISSUES}` **[OFFICIAL]** — a fully-disapproved ad set surfaces as `WITH_ISSUES`, not `DISAPPROVED`. A polling loop that only greps for `DISAPPROVED` at ad-set/campaign level will see nothing.

---

## 3. Reading review outcomes from the API — exact shapes

### 3.1 The one poll that gets everything
```
GET /v26.0/act_<AD_ACCOUNT_ID>/ads
  ?fields=id,name,status,effective_status,
          ad_review_feedback{global,placement_specific},
          issues_info,
          recommendations,
          creative{id,effective_authorization_category},
          preview_shareable_link
  &effective_status=["DISAPPROVED","WITH_ISSUES","PENDING_REVIEW","PREAPPROVED"]
  &limit=200
```
`Ad.Field` (verified **[SDK]**) includes exactly: `ad_review_feedback`, `issues_info`, `failed_delivery_checks`, `recommendations`, `effective_status`, `configured_status`, `preview_shareable_link`, `special_ad_categories`, `conversion_domain`, `creative`, `creative_asset_groups_spec`, `creative_automation_spec`, `source_ad_id`, `execution_options`, …

### 3.2 `ad_review_feedback` → `AdgroupReviewFeedback` **[SDK] [OFFICIAL]**
```
global            : map<string, string>
placement_specific: AdgroupPlacementSpecificReviewFeedback
```
`global` is *"Reasons for review disapproval across all platforms."* The keys are **opaque reason codes that Meta does not publish a dictionary for** — the "Ad Review Feedback Definitions" doc (`/docs/marketing-api/adgroup/feedback/`) is 404 in every version path I tried (`v2.7`, `v2.8`, `v3.2`, `v3.3`, unversioned). Treat the code namespace as *discovered by observation*.

Real observed shape **[OFFICIAL]** (from Meta's own developer blog, <https://developers.facebook.com/ads/blog/post/v2/2017/12/19/targeting-exclusions-update-blog-post/>):
```json
"ad_review_feedback": {
  "global": {
    "HOUSING_OR_CREDIT": "It looks like your ad may be for housing, employment or credit opportunities, or you've included a multicultural affinity segment in your audience. If so, you'll need to certify that you'll comply with our policy prohibiting discrimination and with applicable anti-discrimination laws. Once you certify, we'll review any disapproved ads from the past three days. Typically, this review takes a few minutes. Approved ads will go live. You can visit Ads Manager to manage ad delivery."
  }
}
```
and
```json
"global": {
  "HOUSING_OR_CREDIT_WITH_AFFINITY": "It looks like your ad may be for housing, employment or credit opportunities. These types of ads can't be run using multicultural affinity targeting. How to fix: Remove multicultural affinity targeting from your ad. If you believe your ad isn't for a housing, employment or credit opportunity, you can appeal this disapproval."
}
```
**Design note:** the *value* is a full human-readable remediation sentence, often containing "How to fix:". That string is the highest-signal input to an automated remediation LLM — more useful than the key. Persist both; key for grouping/metrics, value for the fix prompt.

### 3.3 `placement_specific` → `AdgroupPlacementSpecificReviewFeedback` **[SDK]**
Every field is a `map<string,string>` keyed the same way as `global`, one per *surface*. The complete field list (this is not in the human docs in one place):

```
account_admin, ad, ads_conversion_experiences, b2c, b2c_commerce_unified, bsg,
city_community, commerce, compromise, daily_deals, daily_deals_legacy, dpa,
dri_copyright, dri_counterfeit, facebook, facebook_pages_live_shopping,
independent_work, instagram, instagram_shop, job_search, lead_gen_honeypot,
marketplace, marketplace_home_rentals, marketplace_home_sales, marketplace_motors,
marketplace_shops, max_review_placements, neighborhoods, page_admin, product,
product_service, profile, seller, shops, traffic_quality, unified_commerce_content,
whatsapp
```

Read the non-obvious ones:
- **`dri_copyright` / `dri_counterfeit`** — "DRI" = the IP-rights-holder-report pipeline. A hit here means a **rights-holder complaint**, not an ML classifier. Escalation path and legal exposure are completely different from a normal disapproval: repeat hits here are the fastest route to Page/asset action. Alert on these separately and **halt the offending creative lineage globally**, not just the one ad.
- **`traffic_quality`** — landing-page/destination quality signal.
- **`lead_gen_honeypot`** — Meta plants honeypot leads into Lead Ads. If you auto-generate lead forms, mishandling honeypot leads is detectable.
- **`ad`** — the generic ad-level bucket; most creative-policy hits land here or in `global`.

**Gotcha:** a disapproval can be `placement_specific` only — the ad is `DISAPPROVED` on Instagram and fine on Facebook. If your remediation logic reads only `global` it will see `{}` and conclude "no reason given."

### 3.4 `issues_info` → `AdgroupIssuesInfo` **[SDK] [OFFICIAL]**
```
error_code   : int      # "Error code for the issue"
error_message: string   # "Error message for this ad with issue"
error_summary: string   # "Error summary for this ad with issue"
error_type   : string   # HARD_ERROR | SOFT_ERROR
level        : string   # ad | adset | campaign
mid          : string   # "Message id, used for developers to report issues"
```
`issues_info` is *delivery blockers*, which overlaps but is not identical to `ad_review_feedback`. `error_type=HARD_ERROR` → will never deliver until fixed. `SOFT_ERROR` → degraded but may deliver. Ad-set-level `issues_info` uses `AdCampaignIssuesInfo` with the same shape (observed codes include `2460003`, `2460004`) **[OFFICIAL]**.

**Route by `level`, not by the object you queried** — an ad's `issues_info` can carry `level: "campaign"` entries. Fixing the ad will not clear those.

### 3.5 `failed_delivery_checks` → `DeliveryCheck` **[SDK]**
```
check_name : string
description: string
summary    : string
extra_info : DeliveryCheckExtraInfo
```
Available on `Ad` and `AdAccount`. This is the pre-delivery sanity layer (missing pixel, no payment method, budget below floor, disabled Page). Poll it alongside `issues_info`; it catches "why is nothing spending" cases that never produce a disapproval.

### 3.6 Pre-flight: the two validation modes on `POST /act_<ID>/ads` **[OFFICIAL]**
`execution_options` (enum, **[SDK]** `class ExecutionOptions`): `validate_only`, `synchronous_ad_review`, `include_recommendations`.

Verbatim from <https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads/>:
- `validate_only` — *"when this option is specified, the API call will not perform the mutation but will run through the validation rules against values of each field."*
- `synchronous_ad_review` — *"this option should not be used by itself. It should always be specified with `validate_only`. When these options are specified, the API call will perform Ads Integrity validations, which include message language checking, image 20% text rule, and so on, as well as the validation logics."*
- `include_recommendations` — *"this option cannot be used by itself… A separate section [recommendations] will be included in the response, but only if recommendations for this specification exist."*
- Response contract: *"If the call passes validation or review, response will be `{"success": true}`. If the call does not pass, an error will be returned with more details."*

```bash
curl -X POST "https://graph.facebook.com/v26.0/act_<AD_ACCOUNT_ID>/ads" \
  -F "name=preflight" \
  -F "adset_id=<ADSET_ID>" \
  -F 'creative={"creative_id":"<CREATIVE_ID>"}' \
  -F "status=PAUSED" \
  -F 'execution_options=["validate_only","synchronous_ad_review","include_recommendations"]' \
  -F "access_token=<TOKEN>"
```
**This is the single highest-leverage integration in the whole compliance design: a free, synchronous, first-party policy check before any object is created and before any spend.** Run it on every generated creative variant.

**Caveats:**
- It is *not* the final decision. Secondary reporting states *"The results returned by synchronous_ad_review do not represent the final decision made during full review of your ad."* **[2ND]** — consistent with Meta's "re-review at all times" language.
- It does **not** fetch or evaluate your landing page (the async review does).
- Its coverage is described in terms of legacy checks ("image 20% text rule") — the 20% text rule was retired as a hard rejection years ago, so the doc string is stale. Depth of 2026 coverage is **[UNVERIFIED]**; measure it by A/B-ing preflight verdicts against real review outcomes and keep a rolling precision/recall number.

### 3.7 Two other free pre-flight surfaces
- **Media-level ad format validation** **[OFFICIAL]** — `GET /{business-video-id}/ad_placement_validation_results` (also on `{business-image-id}`, and via `GET /{business-id}/creatives?fields=ad_placement_validation_results`), with `validation_ad_placements=[FACEBOOK_STORY_MOBILE, …]` and `validation_only=true` (which *"rejects uploads and returns only validation results"*; with no placements specified it *"defaults to running validation for all ad placements"*). Response rows: `{ad_placement, ad_placement_label, is_valid, error_messages[]}` with strings like `"Fb Story Ads Resolution Is Too Low"`, `"Ad Video Duration Is Too Short"`. **This is format/technical only — it does not evaluate content policy.**
- **Ad preview** **[OFFICIAL]** — `GET /v26.0/act_<AD_ACCOUNT_ID>/generatepreviews?creative=<spec>&ad_format=<ENUM>`. ~75 `ad_format` enum values including `FACEBOOK_REELS_MOBILE`, `INSTAGRAM_REELS`, `INSTAGRAM_STORY`, `MOBILE_FEED_STANDARD`, `FACEBOOK_STORY_MOBILE`, `WATCH_FEED_MOBILE`, `INSTAGRAM_EXPLORE_IMMERSIVE`, `WHATSAPP_STATUS_MEDIA`, `RIGHT_COLUMN_STANDARD`, … Returns an iframe HTML string. Error `80004` = too many calls to this ad account. Use it to render each variant and run a **vision model over the rendered frame** — this catches crop/overlay/safe-area failures and text-on-image issues that a check on the source asset misses.

---

## 4. AI-generated content in ads — the actual 2026 rules

### 4.1 What is *required* vs what Meta *does on its own*

| | Ordinary (non-SIEP) ads | SIEP ads |
|---|---|---|
| Advertiser must self-declare AI use | **No requirement found in any Meta primary source** | **Yes**, in 5 enumerated scenarios |
| Meta applies a label | Yes — automated detection, "AI info" in **About this ad** | Yes, plus Ad Library annotation |
| Self-disclosure scope, verbatim | — | *"For ads about social issues, elections or politics, advertisers are **already required** to disclose if the image, video or audio are created or edited with AI."* **[OFFICIAL]** <https://www.meta.com/help/artificial-intelligence/355108217670024/> |
| API field to declare | *(none exists)* | `AdCreative.authorization_category = POLITICAL_WITH_DIGITALLY_CREATED_MEDIA` |
| Penalty for non-declaration | n/a | Ad rejected; *"repeated failure to disclose may result in penalties against the advertiser"* |

**[OFFICIAL]** <https://transparency.meta.com/policies/ad-standards/SIEP-advertising/SIEP/>, <https://www.meta.com/help/artificial-intelligence/355108217670024/>, <https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/>, <https://about.fb.com/news/2026/02/meta-prepares-for-2026-us-midterms/>.

**Explicit contradiction call-out.** Multiple 2026 marketing blogs (`1clickreport.com`, `auditsocials.com`, `coinis.com`, `digitalapplied.com`, `llcgeek.com`, `techjacksolutions.com`, `dhruboduti.com`, `jdesigns.info`, `almcorp.com`, `cinerads.com`) state that Meta "made AI disclosure mandatory across Facebook and Instagram ads in 2026," that "Undisclosed AI Content" is the third-largest rejection reason at 14%, and describe a 1-strike/2-strike/3-strike escalation with a 24-hour hold. **None of that appears in Meta's Transparency Center, Business Help Center, Meta Help Center, or newsroom.** The Meta Help Center article on AI labels in ads says the self-declaration requirement is the *political* one and that everything else is detection-driven. Per the brief's instruction: **the docs win; the blogs are treated as unsourced.** Do not build a mandatory-declaration UI on their basis — but do build the label-tolerant design in §4.6, because the outcome (an AI label on your ad) is real either way.

### 4.2 The SIEP AI-disclosure trigger, precisely **[OFFICIAL]**
Disclosure is required when a SIEP ad contains a *photorealistic image or video, or realistic-sounding audio*, that was **digitally created or altered** to depict:
1. *"a real person saying or doing something they did not"*;
2. *"a realistic-looking person that does not exist"*;
3. *"a realistic-looking event that did not happen"*;
4. altered *"footage of a real event that happened"*;
5. *"a realistic event that allegedly occurred, but that is not a true image, video, or audio recording."*

Not required for *"immaterial"* uses — *"resizing, color correction"* and other *"inconsequential"* edits — "unless changes are consequential or material to the claim."
Source: <https://www.facebook.com/government-nonprofits/blog/political-ads-ai-disclosure-policy> **[OFFICIAL]**

*Fact-check note (2026-09-02):* Meta publishes these as **four** bullets, not five — items 2 and 3 above are a single bullet in Meta's text (*"a realistic-looking person that does not exist or a realistic-looking event that did not happen"*). The substance is identical; do not cite "five scenarios" as Meta's own framing. Meta's immaterial-edit examples are also broader than quoted above: *"image size adjusting, cropping an image, color correction, or image sharpening."*

Enforcement: *"If we determine that an advertiser has not disclosed as required, we will reject the ad, and repeated failure to disclose may result in penalties against the advertiser."*

**Note scenario 2 carefully: a fully synthetic person who does not exist triggers disclosure — in SIEP ads.** An AI-UGC "spokesperson" is exactly this. If any campaign is ever categorised `ISSUES_ELECTIONS_POLITICS`, every synthetic-presenter creative in it needs `POLITICAL_WITH_DIGITALLY_CREATED_MEDIA`.

### 4.3 The API surface for AI/political disclosure **[SDK]**
`AdCreative.authorization_category`, `class AuthorizationCategory`:
```
NONE
POLITICAL
POLITICAL_WITH_DIGITALLY_CREATED_MEDIA
```
Companion read-only field `AdCreative.effective_authorization_category` (string) — *what Meta's system concluded the ad is*, which can differ from what you set. **This is a free classifier output: if you set `NONE` and `effective_authorization_category` comes back `POLITICAL`, Meta has decided your ad is political.** That is a high-priority alert — it means the ad needs authorization + a disclaimer + a special ad category, and in the EU it means the ad is simply not runnable (§5.4).

`authorization_category` *"cannot be used for Dynamic Ads."* **[OFFICIAL]** — and so, per the same reference, does **`effective_authorization_category`**; both fields are unavailable on Dynamic Ads, so the tripwire in §5.6 does not cover a DPA/Advantage+ catalog campaign. Meta's own wording for the read-only field: *"Specifies whether ad is a political ad or not… This value can be different than the `authorization_category` value in case our systems have identified the ad as political even though it was not configured to be labeled as such."* **[OFFICIAL]** <https://developers.facebook.com/docs/marketing-api/reference/ad-creative/>

### 4.4 `generative_asset_spec` — the AI-provenance field on creatives **[SDK]**
`AdCreative.generative_asset_spec` → `AdCreativeGenerativeAssetSpec`, which has exactly **one** field:
```
transparency_metadata : Object
```
This is the hook Meta uses to carry AI-transparency metadata on a creative. **Its object schema is not published** — the codegen'd type is the untyped `Object`. **[UNVERIFIED]** whether it is writable by third-party advertisers or populated only by Meta's own Advantage+ generative features. Probe it in a sandbox account: read it back on a creative built from Meta's own gen-AI features, and attempt a write on one built from your own asset. **Do not make it load-bearing.**

### 4.5 Detection: what Meta actually reads
- **[OFFICIAL]** Meta reads *"industry standard AI image indicators"* and self-disclosure. From Feb 2024: Meta is building tools to identify *"the 'AI generated' information in the C2PA and IPTC technical standards"*, enabling labels on images from **Google, OpenAI, Microsoft, Adobe, Midjourney and Shutterstock**. <https://about.fb.com/news/2024/02/labeling-ai-generated-images-on-facebook-instagram-and-threads/> **[OFFICIAL-IDX]**
- **[OFFICIAL]** For ads: *"We will also begin automatically detecting ads created or edited using third-party AI tools through industry-standard signals… When detected, we'll apply an 'AI info' label included in About this ad."* ~~Effective **2026-06-01**.~~ **CORRECTED 2026-09-02:** the post is dated "Originally published February 3, 2025" and carries "Update on June 1, 2026 at 9:00AM PT to reflect updates to the product," but the sentence itself is still future-tense — *"We **will also begin** automatically detecting…"* — and **no launch date is stated anywhere in it**. 2026-06-01 is the page's edit timestamp, not a go-live date. Meta's Help Center does describe the label in the present tense (*"If an ad was created or significantly edited using Meta's generative AI creative features **or created or edited using third-party AI tools**, the AI info label will appear on the About this ad screen"* — <https://www.meta.com/help/artificial-intelligence/355108217670024/>), so detection is plausibly live; the **date** is [UNVERIFIED]. <https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/>
- Label placement **[OFFICIAL]**: third-party AI → "AI info" inside **About this ad** (three-dot menu). Meta's own gen-AI creative features → in the three-dot menu for significant edits, **or next to the "Sponsored" label** when photorealistic humans are generated. Minimal edits with no photorealistic humans → **no label**.
- **SynthID:** Google's Veo/Flow outputs carry SynthID (an in-pixel watermark) *and* C2PA Content Credentials **[2ND]**. **I found no Meta source saying Meta reads SynthID.** SynthID is Google-proprietary and detected by Google's tooling. **The interoperable path into Meta's detector is C2PA/IPTC metadata, not SynthID.** Mark "Meta detects SynthID" as **[UNVERIFIED] — assume false.**
- **Practical consequence:** C2PA is *file metadata* and is stripped by most re-encode pipelines (ffmpeg drops it unless explicitly carried). SynthID survives re-encode. So a pipeline that renders Veo clips through ffmpeg will very likely arrive at Meta with **no C2PA manifest**, and Meta's classifier-based detection becomes the only signal. **Do not treat "we stripped the metadata" as a strategy** — see §4.7 (it is a Terms violation for Meta-generated assets, and an EU AI Act problem generally).

### 4.6 Design rule: assume the label, design for it
You cannot reliably prevent an "AI info" label and you cannot remove one. Therefore:
- Never write ad copy whose claim depends on the footage being real (e.g. "real customer, real results", "unscripted", "filmed on location"). An "AI info" label next to that copy converts a stylistic choice into a *deceptive practice* under §1.3.
- Prefer obviously-stylised / non-photoreal creative for high-risk verticals; photorealistic synthetic humans are the highest-scrutiny category and the one Meta labels most prominently (next to "Sponsored").
- **[UNVERIFIED]** whether the AI-info label measurably depresses CTR/CVR. Instrument it: run matched-pair tests of labelled vs unlabelled creative and hold the answer as an internal metric, because there is no public data.

### 4.7 Meta's own generative output is contractually locked to Meta **[OFFICIAL]**
From the **Ad Creative Generative AI Terms** <https://www.facebook.com/legal/terms/ad_creative_generative_ai_terms>:
- *"Use or publication of Output outside of Meta's platforms is unauthorized and a violation of these Terms."*
- *"You are solely responsible for evaluating the Output and determining its accuracy, suitability, completeness, and the appropriateness of using or publishing the Output."*
- Users must not misrepresent Output as human-made, and **must not remove watermarks or authentication metadata**.
- Meta disclaims all warranties as to output uniqueness or IP protection. **Exact wording (corrected 2026-09-02 — the previously quoted phrasing was a paraphrase):** Meta makes *"no warranty that Ad Content will be unique, protected by intellectual property rights, or that it will not infringe third-party rights."*
- Meta reserves the right that it *"or any entity acting on our behalf may access, index, cache, analyze, or crawl … domains, webpages or URLs provided by you."* — i.e. **your landing pages are crawled, by contract.**

**Two hard consequences.** (1) Anything produced by Meta's Advantage+ / Marketing-API generative features (`degrees_of_freedom_spec.creative_features_spec.{text_generation, image_uncrop, image_background_gen}` with `enroll_status: OPT_IN|OPT_OUT` **[OFFICIAL]**) **cannot be reused on TikTok, YouTube, your website, or in your own asset library.** If the platform is multi-channel, generate outside Meta. (2) Stripping provenance metadata from Meta-generated assets is an explicit Terms breach.

### 4.8 EU AI Act Article 50 — this is live *now* **[OFFICIAL]**
Article 50 **applies from 2 August 2026** — one month ago. <https://artificialintelligenceact.eu/article/50/>, <https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act>

- **Art. 50(2) — providers:** systems generating *"synthetic audio, image, video or text content, shall ensure that the outputs of the AI system are marked in a machine-readable format and detectable as artificially generated or manipulated."* Exempt where the AI performs *"an assistive function for standard editing"* or does *"not substantially alter the input data."*
- **Art. 50(4) — deployers (this is you):** deployers of a system that generates a **deepfake** *"shall disclose that the content has been artificially generated or manipulated."* Where the content is *"evidently artistic, creative, satirical, fictional or analogous"*, disclosure is limited to acknowledging it *"in an appropriate manner that does not hamper the display or enjoyment."*
- **Art. 50(5) — timing:** *"at the latest at the time of the first interaction or exposure"*, in a *"clear and distinguishable manner."*
- **Deepfake definition (3 criteria):** resemblance to a real subject, the subject actually exists, and false appearance of authenticity. **A wholly synthetic person who does not exist is arguably not a "deepfake" under this test** — but the Art. 50(2) *marking* obligation on the generator still applies, and Meta's own labelling still fires.
- **Grace period:** AI systems placed on the market before 2026-08-02 have until **2 December 2026** to meet the Art. 50(2) machine-readable-marking obligation. ~~(AI Omnibus provisional agreement, May 2026)~~ **CORRECTED 2026-09-02:** the 2 December 2026 date is right but the attribution is not. It is a transitional deadline in the AI Act's own implementation timeline — *"Providers of AI systems, including GPAI systems, generating synthetic audio, image, video or text content, that have been placed on the market before 2 August 2026 must have taken the necessary steps to comply with Article 50(2) by this date"* — and the official timeline records **no** Digital/AI Omnibus delay or grace period for Article 50. <https://artificialintelligenceact.eu/implementation-timeline/>
- **Penalties:** up to **€15 million or 3% of worldwide annual turnover**.
- Meta signed the **EU AI Act Code of Practice on Transparency of AI-Generated Content** in July 2026 <https://about.fb.com/news/2026/07/meta-is-signing-the-eu-ai-act-code-of-practice-on-transparency-of-ai-generated-content/>. The signed Code's concrete technical commitments (watermark spec, C2PA profile, retention) were **not enumerated in Meta's post** — **[UNVERIFIED]**; read the Code text itself before relying on any specific obligation.

**Build requirement:** for any ad delivered into the EU that uses a synthetic human likeness resembling a real person, or altered footage of a real event, the platform must render an **in-creative** disclosure (burned-in caption or first-frame supertitle) — Meta's own "About this ad" label is *behind a three-dot menu* and therefore does not satisfy "clear and distinguishable at first exposure." Do not rely on Meta's label for Art. 50 compliance.

### 4.9 US: FTC — the sharper edge for AI testimonials **[OFFICIAL]**
**16 CFR Part 465 — Rule on the Use of Consumer Reviews and Testimonials**, effective **21 October 2024**. <https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465>, <https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials>
- Prohibits creating, selling, buying or **disseminating** fake or false consumer reviews/testimonials where the business *knew or should have known* they were fake.
- **AI-generated reviews are explicitly in scope**; the FTC named AI mass-generation as the motivating harm.
- **Civil penalties** are available against knowing violators (unlike a plain §5 case) — currently >$50k per violation, per-ad-per-day exposure.

**This is the single largest legal risk in "AI-generated video creative for direct response."** An AI-generated person saying "this product changed my life" is a fabricated consumer testimonial. Meta's ad review may well approve it; the FTC rule still bites, and Meta's own *Unacceptable Business Practices* policy independently prohibits *"deceptive or exaggerated claims about the success of a product or service."*

**Hard product rule to encode:** any synthetic on-screen presenter must be framed as a **presenter/spokesperson/narrator**, never as a customer recounting a personal result, and must carry an on-screen "Dramatization — AI-generated presenter" style disclosure when it could read as a testimonial. Make this a non-overridable constraint in the creative generator's system prompt *and* a hard blocker in the pre-flight classifier.

---

## 5. Special Ad Categories

### 5.1 The enum — docs vs SDK disagree, and the SDK is a superset
Human docs (<https://developers.facebook.com/docs/marketing-api/audiences/special-ad-category/>) list **[OFFICIAL]**:
```
HOUSING, EMPLOYMENT, FINANCIAL_PRODUCTS_SERVICES, ISSUES_ELECTIONS_POLITICS, NONE
```
`Campaign.SpecialAdCategories` in the SDK **[SDK]** carries two more:
```
CREDIT, EMPLOYMENT, FINANCIAL_PRODUCTS_SERVICES, HOUSING,
ISSUES_ELECTIONS_POLITICS, NONE, ONLINE_GAMBLING_AND_GAMING
```
- `CREDIT` is the **deprecated** input, superseded by `FINANCIAL_PRODUCTS_SERVICES` on **2025-01-14** for US-based advertisers or US-targeted campaigns **[OFFICIAL]**. It still validates but should never be emitted by new code.
- `ONLINE_GAMBLING_AND_GAMING` is real and absent from the doc page. If you ever touch gambling verticals, this is the value.

### 5.2 Required fields **[OFFICIAL]**
*"All campaign creations require the `special_ad_categories` field."* Default `NONE`.

```json
POST /v26.0/act_<AD_ACCOUNT_ID>/campaigns
{
  "name": "…",
  "objective": "OUTCOME_SALES",
  "status": "PAUSED",
  "special_ad_categories": ["EMPLOYMENT"],
  "special_ad_category_country": ["US"]
}
```
`special_ad_category_country` = array of **ISO Alpha-2** codes.
- Mandatory whenever any category ≠ `NONE`.
- HOUSING / EMPLOYMENT / FINANCIAL_PRODUCTS_SERVICES: defaults to the advertiser's **tax country** if unset — a silent, wrong default for a multi-country platform. **Always set it explicitly.**
- ISSUES_ELECTIONS_POLITICS: must be a country where **both the user and the Page** are authorized.
- Also settable/readable at ad level (`Ad.special_ad_categories` **[SDK]**), and on `POST /v26.0/<CAMPAIGN_ID>` updates.

### 5.3 Targeting restrictions Meta enforces server-side **[OFFICIAL]**
| Dimension | Restriction |
|---|---|
| Age | *"Options are generally fixed to include ages 18 through 65+"* (EU credit ads are the documented exception) |
| Gender | Cannot select; *"genders defaults to all genders"* |
| Location radius | Minimum **15 miles / 25 km** (US, Canada); **15 km** (Europe) |
| Location types **banned** | `subcity`, `neighborhood`, `metro_area`, `small_geo_area`, `subneighborhood`, `electoral_district`, `zips` |
| Location exclusion | Not supported at all |
| Detailed targeting | Behavior and demographic targeting prohibited; interest/demographic **exclusions** prohibited; restricted to a pre-approved interest list |
| Lookalikes | *"Lookalike audiences are unavailable"* |
| Saved audiences | Not available |
| Custom audience eligibility | Check `is_eligible_for_sac_campaigns` on the audience before attaching |

Special Ad Audiences (the old lookalike substitute) no longer exist. **[2ND]**

### 5.4 Error codes **[OFFICIAL]**
| Code | Meaning |
|---|---|
| `2859024` | *"Certification Required"* — *"A business admin must review and accept our non-discrimination policy before you can run ads."* **Blocks all HEC ads until a human clicks accept in Business Manager. There is no API to accept it.** |
| `2909035` | Targeting violation bundle (custom age, saved audience, lookalike, radius under minimum, exclusions, bid multipliers) |
| `2708008` | SIEP authorization missing — user must confirm ID or be added as an authorized user |
| `1404163` | *"You're no longer allowed to use Facebook Products to advertise…"* — terminal advertiser ban |

### 5.5 The EU political-ads prohibition — a hard `POST` failure **[OFFICIAL]**
Effective **2025-10-06 18:00 CET / 09:00 PT**, political, electoral and social-issue ads are **prohibited in the EU**, in response to the EU **TTPA** regulation. <https://about.fb.com/news/2025/07/ending-political-electoral-and-social-issue-advertising-in-the-eu/>, <https://developers.facebook.com/blog/post/2025/10/06/prohibiting-ads-about-social-issues-elections-or-politics-from-running-in-the-eu-due-to-regulation/>

Four endpoints reject such requests: `POST /{ad_account_id}/campaigns`, `/adsets`, `/ads`, `/adcreatives`. Meta's own SIEP policy page now states, **in full** (the commonly-quoted short version truncates the exception and makes it look far broader than it is): *"Ads about social issues, elections or politics are not allowed to run in the European Union, except for ads containing information about the time, place, and manner of voting **or voter registration when placed by election authorities in the EU**."* **[OFFICIAL]** <https://transparency.meta.com/policies/ad-standards/SIEP-advertising/SIEP/> — i.e. the exception is available **only to EU election authorities**, not to any advertiser running a get-out-the-vote message. For a commercial platform the EU SIEP prohibition is absolute.
**Exact error codes were not published** — Meta only tells developers to *"update error handling appropriately."* **[UNVERIFIED]** — capture and catalogue them the first time you hit one.

### 5.6 Authorization for SIEP (non-EU) **[OFFICIAL] / [OFFICIAL-IDX]**
- Advertiser *"located in or targeting people in designated countries must complete the authorization process required by Meta"* (identified news publishers excepted).
- A **verified "Paid for by" disclaimer** is mandatory.
- Ads are archived in the **Ad Library for seven years**; the US archive holds *"more than 18 million US entries."*
- **US 2026 midterms:** Meta *"will block new political, electoral, and social issue ads during the final week of the US election campaign"*; ads with prior impressions may keep running. <https://about.fb.com/news/2026/02/meta-prepares-for-2026-us-midterms/>
- The authorization flow (ID upload, mailing-address notification-code, disclaimer creation) is **human-only, multi-day, and has no API.**

**Architectural verdict for a no-human-in-the-loop platform: treat SIEP as out of scope. Hard-block it.** The authorization is manual, the disclaimer is manual, the EU is closed, and the US has a blackout week. Instead, use `effective_authorization_category` (§4.3) as a **tripwire**: if Meta reclassifies one of your ads as `POLITICAL`, pause the campaign and escalate to a human. "Social issue" is broad — sustainability, immigration, health policy, civil rights, guns, and economy claims can all land there, and an autonomous copywriter will wander into it.

### 5.7 EU DSA beneficiary & payor — **MISSING FROM THE ORIGINAL DRAFT, and it hard-fails EU ad sets** **[OFFICIAL]**

*Added by fact-check 2026-09-02.* The dossier covered the EU AI Act and the EU SIEP ban at length but omitted the one EU rule that breaks an **ordinary commercial** ad set on every publish.

Meta's ad-standards index carries a section **"Transparency requirements under the EU Digital Services Act"** stating that Meta must let EU users identify *"the natural or legal person on whose behalf the advertisement is presented and the natural or legal person who is paying for the ad (if different),"* and therefore: *"when creating an ad, you are required to provide the following information in the associated text fields:"*
- **Beneficiary field** — *"the full legal name of the person, company, business, charity or institution on whose behalf your ad is being presented."*
- **Payor field (if different from above)** — *"the full legal name of the person, company, business, charity or institution who paid for the ad."*
- *"You are responsible for ensuring that this information is complete, accurate and up-to-date for each ad that you submit to Meta, and that it remains so for the entirety of the period during which the ad is running."*

**The API surface is at the ad-set level, not the ad or creative level** **[SDK]** (`facebook_business/adobjects/adset.py`, both in `AdSet.Field` and in the `POST /act_<ID>/adsets` param list):
```
dsa_beneficiary : string   # "The beneficiary of all ads in this ad set."
dsa_payor       : string   # "The payor of all ads in this ad set."
```
**[OFFICIAL]** <https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/>:
- *"Ad sets targeted to the EU and/or associated territories are required to provide beneficiary information (who benefits from the ad running), and payer information (who pays for the ad)."*
- The requirement bites for *"new ads, duplicated ads, or significantly edited ads"* — **note that this is a second, independent reason a "significant edit" is expensive (§9.2)**.
- **Without the information the API returns a validation error** — so this is a hard `POST /adsets` failure, not a soft warning.
- *"The `payer` and the `beneficiary` fields are **only** for ad sets targeting the EU and/or associated territories. For ad sets targeting regions other than the EU and/or associated territories, that information will not be saved even if it is provided."*

**Build requirements:**
1. Collect the client's **full legal entity name** at onboarding — the same datum business verification (§8.2) needs, so collect it once. A trading name or a Page name is not acceptable.
2. Set `dsa_beneficiary` (and `dsa_payor` where the payer differs — agency-on-behalf-of-client is exactly that case) on **every ad set whose targeting can reach the EU or associated territories**. "Associated territories" is broader than the EU-27; treat the geo test as EU/EEA + associated territories, not EU-27.
3. Because the values are ad-set-scoped, a single ad set that mixes EU and non-EU geos still needs them. Setting them unconditionally is harmless outside the EU (Meta simply discards them) — **so the safe default is to always set them**, and that removes a whole class of geo-detection bugs.
4. Add `dsa_beneficiary`/`dsa_payor` to the §11.1 pre-flight assertions and to the §11.5 evidence retention set: the accuracy obligation is continuous (*"for the entirety of the period during which the ad is running"*), so a client legal-entity change must trigger a sweep of live ad sets.

---

## 6. The rejection reasons that will actually hit a DR video pipeline

All quotes **[OFFICIAL]** from <https://transparency.meta.com/…> and <https://www.facebook.com/business/m/small-business/ad-policy-guidance>.

### 6.1 Personal Attributes — the most avoidable rejection for an LLM copywriter
Policy: *"Ads must not contain content that asserts or implies personal attributes"* — *"direct or indirect assertions or implications about a person's race, ethnicity, religion, beliefs, age, sexual orientation or practices, gender identity, disability, physical or mental health (including medical conditions), vulnerable financial status, voting status, membership in a trade union, criminal record, or name."*
Specifically prohibited: sharing or **asking for** personal attributes of the user or their family; implying the advertiser **knows** the user's attributes, PII, financial information, or medical information.
Allowed: broad references not on the list (*"American"*, *"New Yorker"*), and *"passing reference to a personal attribute including gender, age groups or age ranges."*

*Ranking caveat (fact-checked 2026-09-02):* **"#1 / highest-frequency rejection" is unsourced.** Meta publishes no rejection-frequency data. Its own guidance page (<https://www.facebook.com/business/m/small-business/ad-policy-guidance>) names five common rejection reasons — Personal Health & Appearance, Unrealistic Outcomes, Unacceptable Business Practices, Discriminatory Practices, Non-functional Landing Page — and Personal Attributes is **not** on that list. Treat the priority below as an engineering judgement about *this* pipeline (an LLM DR copywriter trips it by construction), not as a Meta statistic.

Meta also **explicitly allows** *"you/your" language without referencing protected characteristics* **[OFFICIAL]** — so the lint below must key on the *conjunction*, never on second person alone, or it will over-block nearly all DR copy.

**The failure mode is grammatical, not semantic: second person + attribute.** An LLM copywriter naturally writes conversion copy in second person, and that is exactly what trips this.
- ✗ "Are you struggling with diabetes?" · ✓ "New options for people managing diabetes"
- ✗ "Meet other single moms in Austin" · ✓ "A community for single parents"
- ✗ "Because you're over 50…" · ✓ "Designed for the 50+ crowd"
- ✗ "Bad credit? We can help you." · ✓ "Credit-rebuilding options"
**Encode as a deterministic rule, not just a classifier:** flag any sentence containing `you/your/you're` within N tokens of any term in the protected-attribute lexicon. Cheap, near-zero false negatives, run it before the LLM classifier.

### 6.2 Personal Health / negative self-perception
*"Ads must not imply or attempt to generate negative self-perception in order to promote diet, weight loss or other health-related products."* **Don't:** *"use before-and-after images displaying idealized results."*
Health and Wellness policy additionally prohibits *"statements of inferiority about physical appearance"*, *"close up on specific body area by pinching fat"*, *"claims that results can be achieved solely by using wearable products"*, skin whitening/bleaching causing permanent colour change, claims to *"cure, heal, or eliminate"* incurable diseases (diabetes, autism, cancer, HIV), and *"clickbait tactics"* with *"exaggerated or extreme claims, or promises of specific outcomes within a set timeframe without disclaimers."*

**Nuance most guides get wrong:** before/after is *not* categorically banned. When targeting 18+, Meta permits *"General cosmetic products, procedures, surgeries depicting before and after transformation"* and *"dietary weight loss or weight gain products… with results illustrations and timeframes clearly indicated."* The ban is on **idealised body-image framing** and on **untargeted** (non-18+) delivery. So: age-gate to 18+ *and* keep the framing product-centric, not body-shaming.
Mandatory 18+ minimum age for: weight loss/gain products, cosmetic procedures, dietary supplements. Exempt: fitness services/health clubs, general food and protein products, non-permanent cosmetics, teeth whitening.

**Pipeline rule:** if the vertical classifier returns health/wellness/beauty/supplement, force `targeting.age_min = 18` at ad-set creation regardless of what the strategy layer asked for.

### 6.3 Unrealistic Outcomes
*"Ads must not contain promises or suggestions of unrealistic outcomes for health, weight loss or economic opportunity."* **Don't:** *"make claims about curing incurable diseases."*
This is the policy that catches "Make $10k/month from your phone", "Lose 30 lbs in 30 days", "Guaranteed results". An AI copywriter tuned for DR performance will generate these constantly — specificity of number + short timeframe + guarantee language is precisely what maximises CTR and what this policy forbids. **Build the constraint into the generator's decoding, not just the filter.**

### 6.4 Unacceptable Business Practices
*"Ads must not promote products, services, schemes or offers using identified deceptive or misleading practices, including those meant to scam people out of money or personal information."* Enumerated:
1. *"Use deceptive or exaggerated claims about the success of a product or service to mislead people into purchasing or sharing sensitive information"*
2. *"Use deceptive or exaggerated claims about health-related benefits of a product or service to mislead people"*
3. *"Use the image of a famous person and misleading tactics in order to bait people into engaging with an ad"* ← **celeb-bait; see §8.4**
4. *"Promise financial benefits by misrepresenting an entity, industry association or news outlet to mislead people"*
Named high-risk categories: investment/banking opportunities, health or weight-loss schemes, misleading free-product promotions, *"products with non-existent functionalities."*
**Don't** (from Meta's guidance page): *"promote services claiming to boost Facebook or Instagram engagement artificially."*

### 6.5 Financial claims
Financial and Insurance Products and Services **[OFFICIAL]** prohibits promotion of **payday loans**, **paycheck advances**, and **short-term loans of 90 days or less**; and of **binary options, CFDs, ICOs, penny auctions**. Requires 18+ targeting; prohibits requesting PII or financial information in the ad; *"Targeting some countries with a financial product or service ad requires a license from the relevant regulatory authorities"* (insurance, mortgages, loans, investment products, credit-card applications). US-targeted investment-product ads *cannot* direct people to DM contact.
**Cryptocurrency** requires evidence of appropriate licensing and **written permission from Meta** — a manual application.

### 6.6 Adult / suggestive content — an AI-video-specific trap
*"Ads must not contain imagery depicting nudity, sexual activity, depictions of people in explicit or sexually suggestive positions, or activities that are sexually suggestive."* No near-nudity *"even with digital overlay."* 18+ gating for revealing clothing, suggestive poses, or people touching sexualized body parts.
**Why this matters for generated video specifically:** text-to-video models drift toward aesthetically-optimised human bodies, tight framing, and "attractive" wardrobe. A prompt as innocuous as "confident woman in activewear demonstrating the product" reliably produces frames that trip the suggestive-content classifier. **Run a frame-level NSFW/suggestiveness scorer over sampled frames (≥1 fps) before submission, not just the thumbnail.**

### 6.7 Low quality / disruptive / engagement bait
- Video Ads policy: *"must not use overly disruptive tactics, such as flashing screens."* (Also an accessibility/photosensitivity issue — cap luminance flash rate in the render pipeline.)
- Objectionable Content: no *"shocking, sensational, or excessively violent content"*, profanity, certain adult content — *"because ads may be delivered to people in their Feed from Pages or accounts they don't follow."*
- Engagement bait (a **ranking** guideline, not an ad rejection): *"posts that explicitly request engagement (such as votes, shares, comments, tags, likes, or other reactions) for purposes other than a specific call to action."* Meta *"demote[s] posts that repeatedly use engagement bait."* <https://transparency.meta.com/features/approach-to-ranking/content-distribution-guidelines/engagement-bait/> **This costs you delivery silently, with no API signal.**

### 6.8 Trademark / brand
Third-Party IP Infringement **[OFFICIAL]**: *"Ads may not contain content that violates the intellectual property rights of any third party, including copyright, trademark or other legal rights."* Explicitly covers *"promotion or sale of counterfeit goods, such as products that copy the trademark (name or logo) and/or distinctive features of another company's products"*, and ads *"likely to confuse people about the source, sponsorship or affiliation"* of goods/services.
**Meta's own brand** is governed separately (`/policies/ad-standards/intellectual-property-infringement/Using-Meta-Intellectual-Property-Licenses/`): you may *"make limited reference to 'Facebook' or 'Instagram' in ad text for the purpose of clarifying the destination when linking to Facebook or Instagram content"*, but you may not make Meta's brands *"the most distinctive or prominent feature"*, pluralise, abbreviate to "FB", uncapitalise outside a URL, use logos as text substitutes, or *"modify Meta's brand assets in any way, such as by changing the design or color, or using them in special effects or animation."*
**Generated-video trap:** image/video models emit plausible-but-fake logos, brand-adjacent packaging, and recognisable trade dress unprompted. Run a logo/brand detector over sampled frames.

---

## 7. Landing page policy

### 7.1 The four rules **[OFFICIAL]**
1. **Match.** *"The products and services promoted in an ad must match those promoted on the landing page."* (Relevance policy, §1.8.)
2. **Functional.** *"Ads must not direct people to non-functional destinations. This includes landing page content that interferes with a person's ability to navigate away from the page."* **Don't:** *"direct people to a landing page that triggers an automatic download of a file."*
3. **Cybersecurity.** *"Ads must not use phishing or social engineering techniques to capture others' sensitive information, and must not promote or link to malicious code — such as malware or spyware."* And: must not *"include links that cause an automatic download upon opening the landing page."*
4. **No cloaking.** ~~Ads must not *"use tactics that are intended to circumvent the ad review process, including techniques that attempt to disguise the ad's content or destination (landing) page."*~~ **[UNVERIFIED — corrected 2026-09-02]:** this exact sentence could not be located at any live Meta URL. The word *"disguise"* does not appear on <https://transparency.meta.com/policies/ad-standards/>, nor in the Cybersecurity or Inauthentic Behavior policies; it appears to survive only from the retired `facebook.com/policies/ads/…` "Circumventing Systems" page. **The rule is still real, but cite the live text instead:** *"Helping anyone evade or circumvent our enforcement of our policies or terms of service is also prohibited."* **[OFFICIAL]** (ad-standards index) and, in the Inauthentic Behavior standard, use of inauthentic assets *"to Evade enforcement under the Community Standards."* **[OFFICIAL]** — Meta sued a Vietnam-based advertiser over exactly this in Feb 2026 and states it *"deployed AI tools to detect cloaking more effectively."*

### 7.2 How automated systems get caught out
Meta fetches your URL from **its own infrastructure**, at unpredictable times, without your session, and repeatedly (re-review at any time). Every one of the following is an *accidental* cloaking or non-functional signal:
- **Geo/IP redirects.** Meta's crawler resolves from a datacentre IP that may be outside your allowed regions → it sees a "not available in your country" interstitial while users see the offer. Reads as mismatch or cloaking.
- **Bot filtering / WAF / Cloudflare challenge.** A JS challenge or 403 to a datacentre ASN reads as a non-functional destination. **Explicitly allow Meta's crawler.**
- **Consent/cookie walls and age gates** that block content until interaction → "interferes with a person's ability to navigate away" / non-functional.
- **A/B testing frameworks** that serve a different variant per visit → the reviewer's page ≠ the ad's claim. Pin the reviewer to the control.
- **Ephemeral / auto-generated LP URLs** with short TTLs, expiring tokens, or per-click query params. If the LP 404s on re-review three weeks later, the ad flips to disapproved and the *account* takes a quality hit. **Landing pages must outlive the ads that point at them.**
- **`conversion_domain` mismatch.** The `Ad.conversion_domain` field **[SDK]** must match the destination's registrable domain and the domain must be verified in Business Manager, or delivery is restricted independently of policy review.
- **Interstitial redirect chains** (link shorteners, tracking hops). Each hop is a chance to look like a disguised destination. Keep the ad's `link` a first-party URL on a verified domain; do redirects server-side after the landing.
- **Missing basics.** Working contact info, a privacy policy, terms, refund/shipping policy, and (for any subscription) clear recurring-billing disclosure. Meta's scam-advertiser suits centred on *"unauthorized recurring charges"*.

### 7.3 Build a landing-page pre-flight gate
Before any ad references a URL, fetch it **twice** — once from a residential-like egress in the target geo, once from a datacentre IP — with a desktop and a mobile UA, and assert: HTTP 200 within ~5 s, no auto-download header (`Content-Disposition: attachment`), no meta-refresh/JS redirect off-domain, the offer keywords from the ad copy present in the rendered DOM, presence of privacy-policy and contact links, and byte-similarity between the two fetches above a threshold (divergence = accidental cloaking). Store the rendered HTML+screenshot as the evidentiary snapshot for appeals. Re-run weekly on every live ad.

---

## 8. Account health — the existential layer

### 8.1 What Meta says triggers restriction **[OFFICIAL] / [OFFICIAL-IDX]**
Meta restricts business assets for: *"severely or repeatedly violating policies"*; *"evading or attempting to evade the review process and enforcement actions"*; *"using inauthentic user accounts to set up business assets"*; and *"managing business assets connected to other abusive assets."*

> **[UNVERIFIED — fact-check 2026-09-02]** This four-item list could **not** be reproduced from any live primary URL: it is absent from `/policies/ad-standards/business-assets/account-integrity/`, from the Account Integrity Community Standard, and from `facebook.com/business/help/975570072950669` (JS-gated, no body text on either `www.` or `m.`). It is directionally consistent with what *is* verifiable, but do not quote it as Meta's wording. **What is verifiable verbatim:** the Account Integrity Community Standard enumerates, as grounds for restricting accounts and entities, *"Close linkage with a network of accounts or other entities that violate or evade our policies"*, *"Coordination within a network of accounts or other entities that persistently or egregiously violate our policies"*, and *"Activity or behavior indicative of a clear violating purpose through a network of accounts"* **[OFFICIAL]** <https://transparency.meta.com/policies/community-standards/account-integrity>. The transitive-linkage conclusion below stands on that text.

The four business-asset ad standards:
- **Account Integrity** — Meta may restrict/disable *"accounts, other entities (Pages, groups, events) or business assets (Business Managers, ad accounts) that demonstrate close linkage with a network of accounts or other entities that violate or evade policies."* **Linkage is transitive.** One bad client on your shared Business Manager can contaminate the portfolio.
- **Inauthentic Behavior** — *"Advertisers cannot create or use inauthentic assets to deceive Meta or our users about their identity or the origin, popularity, or purpose of their content"*, and cannot use inauthentic assets *"including business manager accounts — to evade enforcement."*
- **Spam** — ads *"must not share Deceptive Links or attempt to buy, sell, or exchange platform assets, features, privileges, or engagement."* The underlying Community Standard on Spam covers *"posting, sharing, engaging with content or creating accounts, Groups, Pages, Events or other assets, either manually **or automatically**, at very high frequencies."* ← **the clause that a bulk automated publisher must respect.**
- **Cybersecurity** — phishing/malware/auto-download (§7.1).

### 8.2 "Unusual activity" and forced verification **[OFFICIAL-IDX]**
*"If Meta detects signals of possible misrepresentation, suspicious activity, or inauthentic behavior in your ad content, you may be required to complete a verification process."*
Meta is expanding this hard: the stated goal is that **"verified advertisers drive 90% of our ads revenue by the end of 2026, up from 70% today."** <https://about.fb.com/news/2026/03/meta-launches-new-anti-scam-tools-deploys-ai-technology-to-fight-scammers-and-protect-people/> **[OFFICIAL]**
Verification triggers include *"where they deliver ads"*, *"a history of not following Meta's rules"*, and *"the type of ads they run [being] more susceptible to abuse."*

**Product consequence:** business verification (legal entity documents) and, for some accounts, individual ID verification, will become a **precondition of onboarding**, not an edge case. Build it into signup: collect legal entity name, registration number, address, and a verified domain **before** the first campaign, and treat "verification pending" as a first-class account state that blocks publishing.

### 8.3 Account state, readable from the API **[OFFICIAL]**
```
GET /v26.0/act_<AD_ACCOUNT_ID>
  ?fields=account_status,disable_reason,is_prepay_account,business,
          funding_source_details,failed_delivery_checks
```
`account_status` (int):
| | |
|---|---|
| `1` | ACTIVE |
| `2` | DISABLED |
| `3` | UNSETTLED |
| `7` | PENDING_RISK_REVIEW |
| `8` | PENDING_SETTLEMENT |
| `9` | IN_GRACE_PERIOD |
| `100` | PENDING_CLOSURE |
| `101` | CLOSED |
| `201` | ANY_ACTIVE |
| `202` | ANY_CLOSED |

`disable_reason` (int) — **the most diagnostic field in the whole API and almost never used:**
| | | |
|---|---|---|
| `0` | NONE | |
| `1` | ADS_INTEGRITY_POLICY | creative/policy enforcement |
| `2` | ADS_IP_REVIEW | intellectual-property complaint |
| `3` | RISK_PAYMENT | payments risk |
| `4` | GRAY_ACCOUNT_SHUT_DOWN | |
| `5` | ADS_AFC_REVIEW | |
| `6` | BUSINESS_INTEGRITY_RAR | |
| `7` | PERMANENT_CLOSE | terminal |
| `8` | UNUSED_RESELLER_ACCOUNT | |
| `9` | UNUSED_ACCOUNT | |
| `10` | UMBRELLA_AD_ACCOUNT | |
| `11` | BUSINESS_MANAGER_INTEGRITY_POLICY | portfolio-level, not ad-level |
| `12` | MISREPRESENTED_AD_ACCOUNT | identity/misrepresentation |
| `13` | AOAB_DESHARE_LEGAL_ENTITY | |
| `14` | CTX_THREAD_REVIEW | |
| `15` | COMPROMISED_AD_ACCOUNT | |

**Route on this.** `1` (ADS_INTEGRITY_POLICY) → creative remediation. `2` (ADS_IP_REVIEW) → legal, halt the asset lineage. `11`/`12` → business-identity escalation, and **stop publishing on every account in that portfolio**, because the enforcement is portfolio-scoped. `7` → terminal; migrate the client.

Poll `account_status` + `disable_reason` **before every publish batch**, not on a daily cron. Publishing into a disabled account burns quota and generates errors that count toward `user_errors` in the BUC formula.

### 8.4 Celebrity likeness — a live, aggressively-enforced surface **[OFFICIAL]**
- Meta deployed facial recognition against "celeb-bait", protecting **"more than 500,000 celebrities and public figures around the world"**, which *"more than doubled the volume of celebrity-bait scam ads"* detected in testing. <https://about.fb.com/news/2024/10/testing-combat-scams-restore-compromised-accounts/>, <https://about.fb.com/news/2026/02/meta-takes-legal-action-against-scam-advertisers/>
- Feb 2026: Meta **sued** advertisers who used *"altered images and voices of celebrities"* and *"deepfakes of a prominent physician"*, plus a cloaking operation; and sent **cease-and-desist letters to eight former Meta Business Partners** (~~"marketing consultants"~~ — **corrected 2026-09-02**; the designation matters, these were once badged partners) offering unauthorised account-restoration services and renting trusted accounts to evade enforcement systems. The suits named Brazil-based operators using *"altered images and voices of celebrities to promote fraudulent healthcare products"*; a separate Brazil-based group (Brites Corp) using **deepfakes of a physician** to advertise unapproved healthcare products; a China-based company running celeb-bait investment scams at US and Japanese users; and a Vietnam-based individual *"who used cloaking to circumvent our ad review process."*
- Enforcement actions taken alongside: suspending payment methods, disabling accounts, blocking domains, and **sharing the intel with industry partners**.

**Rules to encode as hard blocks in the generator:**
- Never prompt for, and always detect-and-reject, a generated face resembling a real public figure. Run a celebrity-face matcher over sampled frames; on a hit, discard the render — do not attempt to "blur past it."
- Never clone a real voice. Voice likeness is explicitly in scope ("images **and voices**").
- Never generate a person in a white coat / stethoscope / clinical setting making health claims — the "prominent physician" pattern is the exact fact pattern Meta litigated.
- **Never buy, rent, or "warm up" ad accounts, and never engage un-ban services.** These are the behaviours Meta is issuing C&Ds over, and they convert a recoverable restriction into a permanent portfolio ban under Inauthentic Behavior.

### 8.5 Volume: the four ceilings, and the API that reads them

**(a) Ad limits per Page** — read them, don't guess:
```
GET /v26.0/act_<AD_ACCOUNT_ID>/ads_volume
  ?fields=limit_on_ads_running_or_in_review,
          ads_running_or_in_review_count,
          ads_running_or_in_review_count_subject_to_limit_set_by_page,
          current_account_ads_running_or_in_review_count,
          future_limit_on_ads_running_or_in_review,
          future_limit_activation_date,
          ad_limit_set_by_page_admin,
          ad_limit_scope_business,
          ad_limit_scope_business_manager_id,
          actor_id, actor_name, recommendations
  &page_id=<PAGE_ID>&show_breakdown_by_actor=true
```
**[SDK]** — `AdAccountAdVolume`, `get_ads_volume()` on `AdAccount`; params `page_id`, `recommendation_type`, `show_breakdown_by_actor`. `future_limit_on_ads_running_or_in_review` + `future_limit_activation_date` let you see a tier change **before** it bites.
The published tiers (spend in the highest-spending month of the previous 12) are **[2ND]** only — Meta's own page <https://www.facebook.com/business/help/766697140509126> is JS-gated:
| Monthly spend | Max ads *running or in review* |
|---|---|
| < €100k | 250 |
| €100k – €1M | 1,000 |
| €1M – €10M | 5,000 |
| > €10M | 20,000 |
Ads that are **running or in review** count; **scheduled** ads do not. **Use the API number, treat the table as orientation only.**

**(b) Per-ad-account object ceilings** **[OFFICIAL]** — <https://m.facebook.com/help/652738434773716> (the `m.` host renders where `www.` does not):
| | Regular ad account | Managed advertiser account |
|---|---|---|
| Ads per ad set | 50 | 50 |
| Ad sets | 5,000 | 10,000 |
| Campaigns | 5,000 | 10,000 |
| Ads | 5,000 (*"Only 1,000 of these 5,000 ads can use dynamic creative"*) | 50,000 (*"Only 1,000 … dynamic creative"*) |
| Archived ads/campaigns | 100,000 | 100,000 |
*(This resolves the `UNVERIFIED` note in `meta-api-foundations.md` §8.7 — the 5,000/5,000/5,000 figures are now confirmed against Meta's own help article, plus the 50-per-ad-set and 1,000-dynamic-creative sub-limits, and the 100,000 archived ceiling.)*
**A generative pipeline hits the 5,000-ad ceiling in months. Ship an archival GC job on day one.**

**(c) API rate limits** **[OFFICIAL]** <https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/> — see `meta-api-foundations.md` §8 for the full treatment. Compliance-relevant highlights: `ads_management` hourly quota = `300 + 40 × active_ads` (Limited/dev tier) or `100000 + 40 × active_ads` (Full tier); a separate per-ad-account **point score** (read=1, write=3; max 60 Limited / 9000 Full) which on Limited tier means **~20 writes per 5-minute window per ad account**; and a **100 QPS per (app, ad account)** mutation ceiling. Headers: `X-Business-Use-Case-Usage` (`call_count`, `total_cputime`, `total_time`, `estimated_time_to_regain_access`, `ads_api_access_tier`) and `X-Ad-Account-Usage` (`acc_id_util_pct`, `reset_time_duration`, `ads_api_access_tier`).
**Note `user_errors` in the BUC formula: repeatedly submitting ads that fail validation actively reduces your quota.** Pre-flight (§3.6) is a rate-limit optimisation as well as a policy one.

**(d) Per-object edit limits (policy, not rate limit)** — ad-set budget: **4 changes/hour** (`#613` subcode `1487632`); ad-account spend limit: **10 changes/day**.

### 8.6 How legitimate high-volume tools stay alive
Synthesising the policy language above into operating constraints:
1. **One Business Manager per client, never a shared "everything" portfolio.** Account Integrity enforcement follows *linkage*; isolate the blast radius.
2. **Never create Pages, users, or ad accounts in bursts.** The Spam standard names *"creating accounts, Groups, Pages, Events or other assets, either manually or automatically, at very high frequencies."* Onboard on a per-client cadence, gated on business verification.
3. **Pace publishes.** Even inside the object ceilings, a step-function from 20 ads/day to 2,000 ads/day on one account is exactly the signal "unusual activity" is looking for. Ramp geometrically with a per-account daily cap that scales with account age and spend.
4. **Keep the disapproval rate low as an explicit SLO.** Meta enforces on repeat violation. Target < 2% disapproval rate per account per rolling 30 days; **auto-suspend generation for an account that exceeds it** and route to human review. This is the single most important account-safety control you can build, and it is entirely within your power.
5. **Never re-submit an identical rejected creative.** Repeat submission of known-violating content is "evading enforcement."
6. **Publish `PAUSED`, then activate.** Create everything in `status=PAUSED`, let review complete, activate only what is `PREAPPROVED`/`ACTIVE`. Cheaper, safer, and gives you a gate.
7. **Never touch account rental, un-ban services, or proxy identities** (§8.4).
8. **Respect the objective/permission surface** — a tool acting on client accounts is bound by Meta's Platform Terms; see `meta-api-foundations.md` §11.1.

---

## 9. Appeals

### 9.1 There is no appeals API — verified negative **[SDK]**
The `Ad` node's complete edge list, from Meta's own codegen'd SDK:
```
/adcreatives  /adlabels  /adrules_governed  /copies
/insights     /leads     /previews          /targetingsentencelines
```
No `appeal`, no `request_review`, no `policy` edge. `AdAccount` likewise has no appeal edge (its policy-adjacent edges are `ads_volume`, `delivery_estimate`, `dsa_recommendations`, `generatepreviews`, `ios_fourteen_campaign_limits`).

Appeals happen in **Account Quality** (web UI). Confirmed verbatim on the ad-standards index **[OFFICIAL]**: *"**Request another review:** If you believe the ad, ad account, user account, Page or Business Account was incorrectly rejected or restricted, you can request a review of the decision in Account Quality."*
~~account-restriction reviews are *"typically completed in 48 hours"*~~ — **[UNVERIFIED, 2026-09-02]:** <https://www.facebook.com/business/help/530209463124901> is JS-gated on both the `www.` and `m.` hosts and returns no body text. Do not quote the 48-hour SLA; instrument your own observed turnaround instead.

### 9.2 What you *can* do programmatically
1. **Edit-to-re-review — now confirmed, definite not conditional.** The ad-standards index states **[OFFICIAL]**: *"**Create a new ad or edit your ad:** You may create a new ad or edit your ad to comply with our policies. **These ads will be treated as new ads and reviewed by our ad review system.**"* So an edit is not "may re-review" — it *is* a re-review, and the edited ad is treated as new. (This resolves open question §13.6 in the direction of *edits do re-enter review*; whether the ad keeps delivering meanwhile is still unmeasured.) Because `AdCreative` objects are effectively immutable, "editing the creative" means: create a new `AdCreative`, then `POST /v26.0/<AD_ID>` with `{"creative": {"creative_id": "<NEW_ID>"}}`.
2. **Prefer new-ad-in-same-ad-set over edit.** Editing an ad's creative is a **significant edit** and can disturb the ad set's learning phase (`AdSet.learning_stage_info.last_sig_edit_ts` — see `meta-insights-measurement.md` §6). Creating a *new* ad and pausing the disapproved one preserves ad-set learning better.
3. **Escalate `dri_copyright` / `dri_counterfeit` to humans immediately.** These are rights-holder reports; an automated "tweak and resubmit" loop against an IP complaint is the definition of evasion.
4. **Cap the loop.** Hard limit: **2 automated remediation attempts** per creative lineage, then quarantine and require a human. An unbounded generate→submit→reject→regenerate loop is a machine for accumulating violations, which is precisely what triggers account-level restriction.

---

## 10. Copyright, music and likeness in generated video

### 10.1 Music **[OFFICIAL]**
*"If your ad contains music you are required to secure the necessary licenses (e.g. for the sound recording and/or the musical composition) in order to avoid infringing or violating the intellectual property rights of music rights holders."* <https://transparency.meta.com/policies/ad-standards/intellectual-property-infringement/third-party-infringement/>

- **Instagram's licensed music library is for organic content, not ads.** Popular commercial tracks available to creators are *not* cleared for advertising. **[UNVERIFIED — fact-check 2026-09-02]:** no Meta primary source stating this was located. It is the industry consensus and is the conservative reading of the Sound Collection terms below (which *are* verbatim-confirmed), but it is **not** a quoted rule. Do not cite it to a client as Meta policy; rely instead on the affirmative rule that *is* official — an ad containing music requires you to hold the sound-recording and composition licences yourself.
- **Meta Sound Collection** grants *"a non-exclusive, royalty-free license… for commercial or non-commercial purposes in content they create, upload, and distribute on Meta Company Products"*, but *"may not perform, distribute, make available or otherwise use the audio content separately from the Meta Company Products."* <https://www.facebook.com/sound/collection/terms> **[OFFICIAL-IDX]**
  → **Same trap as §4.7: Sound Collection audio cannot be reused on TikTok/YouTube/your site.** For a multi-channel platform, license music independently (or generate it) and keep a per-asset licence record.
- **AI-generated music** carries its own risk: the licence terms of the generator determine commercial-use rights, and generators can produce melodically-derivative output. Keep the generator, model version, prompt, seed, and licence terms in the asset's provenance record.

### 10.2 Two enforcement paths, very different consequences **[OFFICIAL]**
Meta may reject or remove ads *"after being reported to us by an intellectual property rights holder or because there are signs that the ad may infringe the rights of a third party."*
- **Classifier path** → ordinary disapproval, `ad_review_feedback.global`.
- **Rights-holder report path** → `placement_specific.dri_copyright` / `dri_counterfeit`, and it feeds `disable_reason = 2 (ADS_IP_REVIEW)` at account level. **Treat any DRI hit as a Sev-2 incident.**

### 10.3 Generated-video-specific IP risks
- **Fabricated logos and trade dress** appearing unprompted in renders.
- **Recognisable faces.** Diffusion models can emit near-likenesses of real people from generic prompts. This is simultaneously a Meta policy violation (§6.4 item 3), a right-of-publicity claim, and — in the EU — an Art. 50(4) deepfake disclosure obligation.
- **Architectural / landmark and artwork depiction** (jurisdiction-dependent freedom-of-panorama issues).
- **Stock assets:** most stock licences prohibit use in a *"sensitive subject"* context (health, finance, dating) without a model-release-backed extended licence, prohibit depicting a model as endorsing a product, and prohibit using the asset as training input. If the pipeline uses stock as image-to-video seed input, **that is very often a licence breach** independent of Meta.
- **Provenance ledger requirement:** for every shipped asset store `{generator, model_id, model_version, prompt, negative_prompt, seed, source_reference_assets[], licence_id, c2pa_manifest, generated_at, operator}`. When a rights-holder complaint lands, this record is the entire defence and the only way to find every other ad sharing the tainted lineage.

---

## 11. What the platform should build

### 11.1 Pre-flight gate (before any Meta write)
Run in this order, cheapest first, fail closed:
1. **Deterministic lint.** Protected-attribute lexicon × second-person proximity (§6.1); banned-claims regex (guarantee / cure / #1 / "in X days" + numeric outcome); profanity; competitor-trademark list; Meta-brand misuse patterns.
2. **Vertical & special-category classifier.** Emits one of the ~45 Advertising-Standards policy labels plus a special-ad-category prediction. Drives `special_ad_categories`, forced `age_min=18`, and the SIEP hard-block.
3. **Frame-level vision checks** on the rendered video at ≥1 fps: NSFW/suggestiveness, celebrity-face match, logo/trademark detection, before/after-pair detection, on-screen-text OCR (then re-run step 1 over the OCR output — **most policy-violating text in video ads is burned into the frame, invisible to a text-only check**), flash/luminance-rate check.
4. **LLM policy classifier.** Prompt it with the *verbatim policy text* for the top ~12 policies (Personal Attributes, Personal Health, Unrealistic Outcomes, Unacceptable Business Practices, Health & Wellness, Financial Services, Adult Nudity, Discriminatory Practices, Third-Party IP, Circumventing Systems/landing page, Misinformation, SIEP) plus the ad's copy, OCR text, transcript, 6–8 sampled frames, and the landing-page text. Require structured output: `{policy_id, verdict: PASS|WARN|BLOCK, quoted_policy_clause, offending_span, suggested_rewrite}`. **Requiring it to quote the clause is what stops the classifier from hallucinating rules.**
5. **Landing-page gate** (§7.3).
6. **Meta `validate_only` + `synchronous_ad_review`** (§3.6) — the only first-party verdict available pre-spend.
7. **Preview render + vision pass** via `generatepreviews` (§3.7) for each target placement.

Log every stage's verdict against the eventual real review outcome. **The precision/recall of stages 1–4 against Meta's actual decisions is the core metric of the compliance system**; without it you are guessing.

### 11.2 Staged rollout
```
sandbox validate_only  →  PAUSED create  →  1 ad, 1 ad set, floor budget, 24h
   →  PREAPPROVED/ACTIVE confirmed  →  scale ad count  →  scale budget
```
Never launch N creatives simultaneously on a fresh account. Per-account daily publish cap = `f(account_age, 30d_spend, rolling_disapproval_rate)`. Trip the cap → pause generation, alert.

### 11.3 Disapproval handling loop
```python
# poll every 10-15 min for ads in {PENDING_REVIEW, PREAPPROVED, ACTIVE, WITH_ISSUES}
for ad in poll(fields=[...§3.1...]):
    if ad.effective_status == "DISAPPROVED":
        reasons = dict(ad.ad_review_feedback.get("global", {}))
        for surface, m in (ad.ad_review_feedback.get("placement_specific") or {}).items():
            reasons.update({f"{surface}:{k}": v for k, v in m.items()})
        if any(s.startswith(("dri_copyright", "dri_counterfeit")) for s in reasons):
            halt_creative_lineage(ad); page_human("IP complaint"); continue
        if ad.creative.effective_authorization_category in ("POLITICAL",
                "POLITICAL_WITH_DIGITALLY_CREATED_MEDIA"):
            pause_campaign(ad); page_human("reclassified political"); continue
        if remediation_attempts(ad.creative_lineage) >= 2:
            quarantine(ad); page_human("remediation budget exhausted"); continue
        new_creative = remediate(ad, reasons)     # LLM given the verbatim reason strings
        preflight(new_creative)                    # full §11.1 gate again
        create_new_ad_in_same_adset(new_creative)  # NOT an edit — preserves learning
        pause(ad)
    for issue in ad.issues_info or []:
        route(issue.level, issue.error_type, issue.error_code, issue.error_summary)
```
Track a **rolling 30-day disapproval rate per ad account** and per creative-template. Two circuit breakers: account-level (> 2% → stop publishing that account) and template-level (a prompt template whose children get disapproved > 10% → retire the template).

### 11.4 Kill switches you must be able to pull in one call
- Pause every ad on an account (`disable_reason` transitions to a non-zero value, or the disapproval-rate SLO trips).
- Pause every ad sharing a creative lineage (IP complaint).
- Pause every ad pointing at a landing-page domain (LP gate failure or domain complaint).
- Global publish freeze (a Meta policy change lands and your classifiers are stale).

### 11.5 Evidence retention
For every published ad keep, for at least 2 years: the exact creative bytes + hash, all pre-flight verdicts, the `validate_only` response, the landing-page HTML + screenshot at submission and at each weekly re-check, the full provenance ledger (§10.3), the `authorization_category` set and `effective_authorization_category` observed, and every `ad_review_feedback` / `issues_info` payload. This is what you need for an appeal, for an FTC inquiry, and for an EU AI Act deployer-transparency demonstration.

---

## 12. Gotchas — the day-costing list

1. **`DISAPPROVED` is ad-level only.** Ad sets and campaigns surface `WITH_ISSUES`. Grep for the wrong string and your monitor is silently blind.
2. **`ad_review_feedback.global` can be empty while `placement_specific` is populated.** "No reason given" usually means you only read `global`.
3. **The Ad Review Feedback Definitions doc is gone** — 404 at every version path. The reason-code namespace is undocumented. Build your own registry from observation; do not expect a stable, enumerable set.
4. **`synchronous_ad_review` silently no-ops without `validate_only`.** Meta's own text: *"this option should not be used by itself. It should always be specified with `validate_only`."*
5. **`validate_only` + `synchronous_ad_review` does not evaluate your landing page.** A creative can pass pre-flight and be rejected 20 minutes later on destination grounds.
6. **`special_ad_category_country` silently defaults to the advertiser's tax country** for HOUSING/EMPLOYMENT/FINANCIAL_PRODUCTS_SERVICES. Wrong country → wrong targeting restrictions → disapproval you cannot explain. Always set it.
7. **`CREDIT` is deprecated; `FINANCIAL_PRODUCTS_SERVICES` replaced it on 2025-01-14** for US advertisers/audiences — but `CREDIT` still exists in the SDK enum and still validates. Old code silently keeps using the deprecated value.
8. **`ONLINE_GAMBLING_AND_GAMING` exists in the SDK enum but not in the human docs.** If you enumerate categories from the docs page, you will miss it.
9. **Error `2859024` ("Certification Required") cannot be cleared by any API call.** A *business admin* must accept the non-discrimination policy in Business Manager. Every housing/employment/credit ad is blocked until a human clicks. Detect it at onboarding, not at publish time.
10. **SIEP ads are prohibited in the EU since 2025-10-06** and the four affected endpoints hard-fail. Meta did not publish the error codes.
11. **`effective_authorization_category` can disagree with `authorization_category`.** Meta deciding your ad is political is a free, high-value classifier signal — and an emergency.
12. **`AdCreativeGenerativeAssetSpec.transparency_metadata` is typed `Object` with no published schema.** Do not build on it.
13. **Meta's own gen-AI creative output may not be used off Meta** (Ad Creative Generative AI Terms), and **Meta Sound Collection audio may not be used off Meta** (Sound Collection Terms). Both are easy, silent contract breaches for a multi-channel platform.
14. **You may not remove watermarks or authentication metadata** from Meta-generated output — explicit Terms language.
15. **ffmpeg strips C2PA.** A Veo→ffmpeg→Meta pipeline arrives with no provenance manifest. That is not "clean"; under EU AI Act Art. 50(2) it is a marking failure, and it forfeits any benefit of the doubt.
16. **SynthID ≠ C2PA, and there is no evidence Meta reads SynthID.** The interoperable channel is C2PA/IPTC.
17. **Ads are re-reviewed at any time.** An LP that expires, a domain that lapses, a policy that changes — a three-week-old approved ad can flip to `DISAPPROVED` and count against you.
18. **Before/after imagery is not categorically banned** — Meta explicitly allows it for 18+-targeted cosmetic and weight-management ads. The ban is on idealised body-image framing and on failing to age-gate. Over-blocking here costs real performance.
19. **Second-person + protected attribute is the highest-frequency avoidable rejection** and an LLM copywriter produces it by default.
20. **Most policy-violating text in a video ad is burned into the frame.** A text-only classifier over `ad_creative_bodies` sees none of it. OCR every sampled frame and re-run the text lint on the OCR output.
21. **Editing an ad's creative is a "significant edit"** that can reset ad-set learning. Prefer creating a new ad in the same ad set over editing the disapproved one.
22. **`user_errors` reduce your BUC quota.** Failing validation repeatedly costs you throughput as well as reputation.
23. **Enforcement is portfolio-transitive.** `disable_reason = 11 (BUSINESS_MANAGER_INTEGRITY_POLICY)` on one asset means the whole portfolio is implicated. One Business Manager per client.
24. **The Product-and-Format-Specific policies (Video Ads, Relevance, Targeting, Lead Ads, Branded Content) have no dedicated URLs** — they live inline on the index page. A policy-monitoring crawler that follows only links misses the landing-page-match rule entirely.
25. **The FTC Reviews & Testimonials Rule carries civil penalties** and explicitly covers AI-generated testimonials. Meta approving your ad is not a defence.
26. **Never re-submit a rejected creative unchanged, and never use un-ban/account-rental services.** Both are "evading enforcement" and convert a recoverable state into a permanent one; Meta sent C&Ds to **eight former Meta Business Partners** over exactly this in Feb 2026.
27. **`dsa_beneficiary` / `dsa_payor` are required on every EU-targeted ad set and the API returns a validation error without them** (§5.7). They are **ad-set-scoped**, they are silently discarded outside the EU (so set them unconditionally), and the obligation to keep them accurate runs for the whole time the ad is live.
28. **`effective_authorization_category` is unavailable on Dynamic Ads**, exactly like `authorization_category`. The "Meta reclassified my ad as political" tripwire (§5.6) is blind on DPA/catalog campaigns.
29. **The `/policies/ad-standards/business-assets/*` pages are one-sentence pointers.** The enforceable text is in the Community Standards. Crawl the wrong one and your policy-drift monitor is inert.
30. **The EU SIEP "time, place and manner of voting" exception is only for EU election authorities** — the widely-circulated short quote truncates that away and reads as a general exemption. It is not one.

---

## 13. Open questions / UNVERIFIED

1. **Depth of `synchronous_ad_review` coverage in 2026.** The documentation string still cites the retired "image 20% text rule". Which modern classifiers it actually runs is unknown. → Measure precision/recall against real outcomes from day one.
2. **The `ad_review_feedback` reason-code dictionary.** No published enumeration exists. Only two real keys are confirmed (`HOUSING_OR_CREDIT`, `HOUSING_OR_CREDIT_WITH_AFFINITY`), both from a 2017 blog post.
3. **`AdCreativeGenerativeAssetSpec.transparency_metadata` schema and writability.** Untyped `Object`; unknown whether third parties can set it.
4. **Whether an "AI info" label measurably affects delivery, CPM, or CTR.** No public data.
5. **Exact error codes for the EU SIEP prohibition.** Meta declined to publish them.
6. ~~**Whether an edit triggers re-review.**~~ **RESOLVED 2026-09-02:** it does, definitively — *"These ads will be treated as new ads and reviewed by our ad review system"* (ad-standards index). What remains open is only **whether the ad keeps delivering during that re-review**; the learning-phase help page is JS-gated and unreadable.
7. **Whether Meta reads SynthID.** No Meta source says so. Assume no.
8. **The blogs' claim of a formal AI-disclosure strike ladder (1 strike → rejection, 2 within 90 days → 24h hold, 3 → suspension).** No primary source. Meta does publish a strike ladder for **Community Standards** violations on personal Facebook accounts (1 warning; 2–6 feature restrictions; 7 → 1-day; 8 → 3-day; 9 → 7-day; 10+ → 30-day content-creation restriction) — that is a *different system* from advertising restrictions, which Meta does not publish thresholds for.
9. **The exact ad-limits-per-Page spend tiers.** Official page is JS-gated; only the API number (`limit_on_ads_running_or_in_review`) is trustworthy.
10. **Whether `special_ad_categories` on the `Ad` object behaves differently from the campaign-level field.** It exists in the SDK; its interaction with the campaign value is undocumented.
11. **The concrete technical commitments in the EU AI Act Code of Practice on Transparency of AI-Generated Content that Meta signed (July 2026).** Meta's post did not enumerate them; the Code text must be read directly.
12. **Whether Meta's automated third-party-AI detection has an advertiser-facing dispute path.** No documentation found. **And, corrected 2026-09-02, whether it is live at all:** the Feb-2025 post still reads *"We will also begin automatically detecting…"* with no launch date; 2026-06-01 is only the page's edit timestamp. The Help Center describes the third-party label in the present tense, which is the strongest evidence it has shipped.
13. **Landing-page crawler identity.** Meta does not publish its ad-review crawler's User-Agent or IP ranges, which makes "explicitly allow the reviewer" hard to implement precisely.
14. **The exact provenance of the "circumventing systems / disguise the ad's content or destination (landing) page" rule.** The sentence is quoted all over the web but is not on any live Meta URL I could reach (§7.1 item 4). The prohibition survives in different words; the old wording appears to be from a retired policy page.
15. **Meta's published turnaround for business-asset restriction reviews.** The "48 hours" figure cannot be verified — the source page is JS-gated. Measure your own.
16. **Whether the four-item business-asset restriction-trigger list (§8.1) is Meta's actual wording.** Not reproducible from any live primary URL.
17. **Rejection-reason frequency rankings.** Meta publishes none. Every "X% of rejections are Y" figure in circulation — including "Personal Attributes is #1" — is unsourced.

---

## 14. Source index

**Meta Advertising Standards (Transparency Center)**
- Index / review process / format policies — https://transparency.meta.com/policies/ad-standards/
- Community Standards — https://transparency.meta.com/policies/ad-standards/community-standards/
- Discriminatory Practices — https://transparency.meta.com/policies/ad-standards/unacceptable-content/discriminatory-practices/
- Fraud, Scams and Deceptive Practices — https://transparency.meta.com/policies/ad-standards/fraud-scams/fraud-scams-deceptive-practices/
- Unacceptable Business Practices — https://transparency.meta.com/policies/ad-standards/fraud-scams/unacceptable-business-practices/
- Health and Wellness — https://transparency.meta.com/policies/ad-standards/restricted-goods-services/health-wellness/
- Financial and Insurance Products and Services — https://transparency.meta.com/policies/ad-standards/restricted-goods-services/financial-services/
- Cryptocurrency Products and Services — https://transparency.meta.com/policies/ad-standards/restricted-goods-services/cryptocurrency-products-and-services/
- Privacy Violations and Personal Attributes — https://transparency.meta.com/policies/ad-standards/objectionable-content/privacy-violations-personal-attributes
- Adult Nudity and Sexual Activity — https://transparency.meta.com/policies/ad-standards/objectionable-content/adult-nudity-and-sexual-activity/
- Third-Party IP Infringement — https://transparency.meta.com/policies/ad-standards/intellectual-property-infringement/third-party-infringement/
- Copyrights and Trademarks — https://transparency.meta.com/policies/ad-standards/intellectual-property-infringement/copyright-and-trademarks/
- Using Meta IP Licenses / Brand Usage — https://transparency.meta.com/policies/ad-standards/intellectual-property-infringement/brand-usage/
- Ads about Social Issues, Elections or Politics — https://transparency.meta.com/policies/ad-standards/SIEP-advertising/SIEP/
- Business assets: Inauthentic Behavior — https://transparency.meta.com/policies/ad-standards/business-assets/inauthentic-behavior/
- Business assets: Spam — https://transparency.meta.com/policies/ad-standards/business-assets/spam/
- Business assets: Cybersecurity — https://transparency.meta.com/policies/ad-standards/business-assets/Cybersecurity/
- Restricting accounts (strike ladder, Community Standards) — https://transparency.meta.com/enforcement/taking-action/restricting-accounts/
- Engagement bait (ranking guideline) — https://transparency.meta.com/features/approach-to-ranking/content-distribution-guidelines/engagement-bait/
- Labeling AI Content (impact data) — https://transparency.meta.com/governance/tracking-impact/labeling-ai-content

**Meta business/help & legal**
- Ad policy guidance / common rejections — https://www.facebook.com/business/m/small-business/ad-policy-guidance
- Political ads AI disclosure policy — https://www.facebook.com/government-nonprofits/blog/political-ads-ai-disclosure-policy
- AI info on ads (Meta Help Center) — https://www.meta.com/help/artificial-intelligence/355108217670024/
- Ad Creative Generative AI Terms — https://www.facebook.com/legal/terms/ad_creative_generative_ai_terms
- Sound Collection Terms — https://www.facebook.com/sound/collection/terms
- Ad limits per Page — https://www.facebook.com/business/help/766697140509126
- Campaign/ad set/ad limits per ad account — https://m.facebook.com/help/652738434773716
- About Ads In Review — https://www.facebook.com/business/help/204798856225114
- Significant edits and learning phase — https://www.facebook.com/business/help/316478108955072
- Request a review if restricted from advertising — https://www.facebook.com/business/help/530209463124901
- About Advertising Restrictions — https://www.facebook.com/business/help/975570072950669
- Verification Requirements for Advertisers — https://www.facebook.com/business/help/810450577622394
- Get authorized for SIEP ads — https://www.facebook.com/business/help/208949576550051

**Meta newsroom**
- Expanding GenAI Transparency for Meta's Ads Products — https://about.fb.com/news/2025/02/gen-ai-transparency-metas-ads-products/
- Labeling AI-Generated Images (C2PA/IPTC) — https://about.fb.com/news/2024/02/labeling-ai-generated-images-on-facebook-instagram-and-threads/
- Our Approach to Labeling AI-Generated Content — https://about.fb.com/news/2024/04/metas-approach-to-labeling-ai-generated-content-and-manipulated-media/
- Ending Political/Electoral/Social Issue Advertising in the EU — https://about.fb.com/news/2025/07/ending-political-electoral-and-social-issue-advertising-in-the-eu/
- Preparing for the 2026 US Midterms — https://about.fb.com/news/2026/02/meta-prepares-for-2026-us-midterms/
- Meta Takes Legal Action Against Scam Advertisers — https://about.fb.com/news/2026/02/meta-takes-legal-action-against-scam-advertisers/
- New Anti-Scam Tools / advertiser verification to 90% — https://about.fb.com/news/2026/03/meta-launches-new-anti-scam-tools-deploys-ai-technology-to-fight-scammers-and-protect-people/
- Testing New Ways to Combat Scams (facial recognition) — https://about.fb.com/news/2024/10/testing-combat-scams-restore-compromised-accounts/
- Signing the EU AI Act Code of Practice — https://about.fb.com/news/2026/07/meta-is-signing-the-eu-ai-act-code-of-practice-on-transparency-of-ai-generated-content/

**Meta for Developers**
- Ad node reference — https://developers.facebook.com/docs/marketing-api/reference/adgroup/
- AdgroupReviewFeedback — https://developers.facebook.com/docs/marketing-api/reference/adgroup-review-feedback/
- AdgroupPlacementSpecificReviewFeedback — https://developers.facebook.com/docs/marketing-api/reference/adgroup-placement-specific-review-feedback
- AdgroupIssuesInfo — https://developers.facebook.com/docs/marketing-api/reference/adgroup-issues-info
- AdAccount reference (account_status, disable_reason) — https://developers.facebook.com/docs/marketing-api/reference/ad-account/
- AdAccount /ads (execution_options) — https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads/
- AdCreative reference (authorization_category) — https://developers.facebook.com/docs/marketing-api/reference/ad-creative/
- generatepreviews — https://developers.facebook.com/docs/marketing-api/reference/ad-account/generatepreviews/
- Media-level ad format validation — https://developers.facebook.com/docs/marketing-api/business-creative-asset-management/guides/media-level-ad-format-validation
- Special Ad Category — https://developers.facebook.com/docs/marketing-api/audiences/special-ad-category/
- Generative AI Features — https://developers.facebook.com/docs/marketing-api/creative/generative-ai-features/
- Marketing API rate limiting — https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/
- Marketing API error reference — https://developers.facebook.com/docs/marketing-api/error-reference/
- Prohibiting SIEP ads in the EU — https://developers.facebook.com/blog/post/2025/10/06/prohibiting-ads-about-social-issues-elections-or-politics-from-running-in-the-eu-due-to-regulation/
- ad_review_feedback JSON example — https://developers.facebook.com/ads/blog/post/v2/2017/12/19/targeting-exclusions-update-blog-post/
- Ad Library ads_archive — https://developers.facebook.com/docs/graph-api/reference/ads_archive/
- ArchivedAd node — https://developers.facebook.com/docs/marketing-api/reference/archived-ad/

**SDK (schema ground truth)**
- https://github.com/facebook/facebook-python-business-sdk — `facebook_business/adobjects/{ad,adcreative,adcreativegenerativeassetspec,adgroupreviewfeedback,adgroupplacementspecificreviewfeedback,adgroupissuesinfo,deliverycheck,adaccount,adaccountadvolume,campaign}.py`

**Regulatory**
- EU AI Act Article 50 — https://artificialintelligenceact.eu/article/50/
- EC FAQ, Art. 50 transparency obligations — https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act
- EC Code of Practice on Transparency of AI-generated Content — https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content
- 16 CFR Part 465 (FTC Reviews & Testimonials Rule) — https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465
- FTC final-rule announcement — https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials
- FTC Q&A — https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers

---

## 15. Fact-check log

**Adversarial re-verification pass, 2026-09-02.** Every claim below was re-checked against a primary source fetched directly this session — Meta developer docs, `transparency.meta.com`, `about.fb.com`, Meta legal terms, the `facebook-python-business-sdk` source on GitHub (`raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/*.py`, fetched and grepped locally), `artificialintelligenceact.eu`, and `ftc.gov`. Nothing was accepted because a blog repeated it.

**Headline result: the dossier is unusually accurate.** Every SDK enum and field list checked matched the codegen'd source character-for-character, including the 37-field `AdgroupPlacementSpecificReviewFeedback` list and both `AdAccount` integer enums. The defects are (a) one over-read date, (b) two truncated quotes that change meaning, (c) one mis-attributed regulatory deadline, (d) several unsourced claims presented at the same confidence as verified ones, and (e) **one substantive omission that hard-fails EU publishing** (§5.7).

### 15.1 Verified correct — no change needed

| # | Claim | How verified |
|---|---|---|
| 1 | `execution_options = {validate_only, synchronous_ad_review, include_recommendations}`; the "Ads Integrity validations… message language checking, image 20% text rule" string; `{"success": true}` response contract | SDK `ad.py :: class ExecutionOptions` (exactly three values) + <https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads/> — the full sentence including "image 20% text rule" is still live, confirming the doc string really is stale |
| 3 | `AuthorizationCategory = {NONE, POLITICAL, POLITICAL_WITH_DIGITALLY_CREATED_MEDIA}`; `effective_authorization_category` can disagree with what you set | SDK `adcreative.py` (exactly three values) + AdCreative reference, which states the divergence explicitly. **Strengthened** — see §4.3 |
| 4 | Ad `effective_status` 12-value enum; `DISAPPROVED` ad-level only; ad-set enum is `ACTIVE, PAUSED, DELETED, CAMPAIGN_PAUSED, ARCHIVED, IN_PROCESS, WITH_ISSUES`; `AdgroupReviewFeedback{global: map<string,string>, placement_specific}`; `AdgroupIssuesInfo` six fields; `error_type` "Can only be HARD_ERROR/SOFT_ERROR"; no published reason-code dictionary | SDK `ad.py`, `adgroupreviewfeedback.py`, `adgroupissuesinfo.py` + `/reference/ad-campaign/`, `/reference/adgroup-review-feedback/`, `/reference/adgroup-issues-info` |
| 5 | 37 `placement_specific` surface fields, exact names incl. `dri_copyright`, `dri_counterfeit`, `traffic_quality`, `lead_gen_honeypot` | SDK `adgroupplacementspecificreviewfeedback.py` — 37 fields, list identical to the dossier's |
| 6 | Ad node has exactly 8 edges, none an appeal; `AdAccount` has no appeal edge | Grepped every endpoint literal in SDK `ad.py` (8, exactly as listed) and `adaccount.py` (74 edges, no appeal/review/policy edge) |
| 7 | Docs list 5 special ad categories, SDK carries 7 incl. `CREDIT` + `ONLINE_GAMBLING_AND_GAMING`; field required on all campaign creations; `special_ad_category_country` defaults to tax country | SDK `campaign.py :: SpecialAdCategories` + <https://developers.facebook.com/docs/marketing-api/audiences/special-ad-category/> (*"Will default to your listed tax country, if it is not set"*) |
| 8 | Age 18–65+, gender not selectable, 15mi/25km + 15km radius floors, the seven banned location types, no exclusions, no lookalikes, no saved audiences, `is_eligible_for_sac_campaigns`; errors `2859024` and `2909035` | Special Ad Category doc — both error codes and their messages appear there verbatim |
| 10 | All ten `account_status` ints and all sixteen `disable_reason` ints | <https://developers.facebook.com/docs/marketing-api/reference/ad-account/> — every mapping matched |
| 13 | 50 / 5,000 / 5,000 / 5,000 (1,000 dynamic creative) regular; 50 / 10,000 / 10,000 / 50,000 managed; 100,000 archived | <https://m.facebook.com/help/652738434773716> — quoted word-for-word |
| 14 | All five Ad Creative Generative AI Terms provisions; Sound Collection licence limited to Meta Company Products | <https://www.facebook.com/legal/terms/ad_creative_generative_ai_terms>, <https://www.facebook.com/sound/collection/terms> |
| 16 | 16 CFR Part 465; AI-generated fake reviews explicitly in scope; "knew or should have known"; civil penalties against knowing violators | <https://www.ftc.gov/news-events/news/press-releases/2024/08/…> — *"reviews and testimonials that misrepresent that they are by someone who does not exist, such as AI-generated fake reviews"*; *"seek civil penalties against knowing violators"*. (eCFR itself 302-redirects to an unblock page and could not be read directly.) |
| 18 | The protected-attribute list, the three prohibitions, the two allowances | <https://transparency.meta.com/policies/ad-standards/objectionable-content/privacy-violations-personal-attributes> — the attribute list matched word-for-word |
| 11 (part) | Spam Community Standard: *"Posting, sharing, engaging with content or creating accounts, Groups, Pages, Events or other assets, either manually or automatically, at very high frequencies."* | <https://transparency.meta.com/policies/community-standards/spam/> — verbatim |
| 2 (core) | AI self-disclosure is **SIEP-only**; no blanket requirement | Three independent primary sources agree: the SIEP transparency policy, the government-nonprofits disclosure blog, and <https://www.meta.com/help/artificial-intelligence/355108217670024/> (*"For ads about social issues, elections or politics, advertisers are **already required** to disclose…"*). **The 2026 blogs claiming blanket mandatory disclosure and a strike ladder remain unsupported. The dossier's call was right.** |
| 15 (part) | Art. 50(2)/(4)/(5) verbatim; applies 2 Aug 2026; deepfake definition; €15M / 3% penalty | <https://artificialintelligenceact.eu/article/50/> and `/article/99/` (Art. 99(4)(g) tier) |
| 12 (part) | 90%-by-end-2026 / 70%-today verification goal; the three verification triggers; 159M scam ads removed in 2025, 92% proactively; 500,000 celebrities | <https://about.fb.com/news/2026/03/…anti-scam-tools…/> and <https://about.fb.com/news/2026/02/meta-takes-legal-action-against-scam-advertisers/> |
| 17 (parts 1–3) | Landing-page match rule; non-functional destinations + auto-download; cybersecurity phishing/malware/auto-download; review covers "an ad's associated landing page or other destinations"; re-review at all times | ad-standards index; <https://www.facebook.com/business/m/small-business/ad-policy-guidance>; `/business-assets/Cybersecurity/` |

### 15.2 Corrected in place

1. **"Third-party-AI detection live 2026-06-01" — over-read.** `2026-06-01` is the newsroom post's *"Update on June 1, 2026 at 9:00AM PT to reflect updates to the product"* stamp. The sentence itself still reads *"We **will also begin** automatically detecting ads created or edited using third-party AI tools"* — future tense, no launch date anywhere in the post. Corrected in §0.1 and §4.5; open question 12 amended. (Meta's Help Center *does* describe the third-party label in the present tense, so it has probably shipped — but the date was invented by inference.)
2. **The EU SIEP exception was truncated in a way that inverts its scope.** Meta's actual sentence ends *"…time, place, and manner of voting **or voter registration when placed by election authorities in the EU**."* The short version circulating everywhere reads as a general get-out-the-vote carve-out. It is available only to EU election authorities. Corrected in §5.5.
3. **The 2 December 2026 AI Act date was mis-attributed** to an "AI Omnibus provisional agreement, May 2026". The date is correct but it is the AI Act's own transitional deadline for providers of systems placed on the market before 2 Aug 2026; the official implementation timeline records **no** Omnibus delay to Article 50. Corrected in §4.8.
4. **"Eight marketing consultants" → "eight former Meta Business Partners."** Meta's wording, and the distinction matters — these were badged partners, which is why the C&D was newsworthy. Corrected in §8.4 and gotcha 26; defendant detail added (Brazil-based celeb-bait operators; Brites Corp for the physician deepfakes; a China-based celeb-bait investment scheme; Lý Văn Lâm, Vietnam, for cloaking).
5. **The cloaking quote in §7.1 item 4 does not exist at any live Meta URL.** *"disguise"* appears nowhere on the ad-standards index, nor in the Cybersecurity or Inauthentic Behavior policies. Replaced with the live text (*"Helping anyone evade or circumvent our enforcement of our policies or terms of service is also prohibited"*) and flagged.
6. **"Personal Attributes is the #1 / highest-frequency avoidable rejection" is unsourced.** Meta publishes no frequency data, and Personal Attributes is not among the five reasons its own guidance page names. Reframed as an engineering judgement, and the heading changed. Also added Meta's explicit allowance of *"you/your" language without referencing protected characteristics* — the lint must key on the conjunction, not on second person.
7. **The "48 hours" restriction-review SLA could not be verified** — the source page is JS-gated on both hosts. Struck and flagged in §9.1.
8. **The four-item business-asset restriction-trigger list (§8.1) could not be reproduced from any live primary URL.** Replaced with the Account Integrity Community Standard's actual bullets, which support the same conclusion.
9. **The Gen AI Terms IP disclaimer was a paraphrase in quotation marks.** Exact text substituted.
10. **"Instagram's licensed music library is for organic content, not ads"** has no primary source. Flagged; the affirmative licensing rule (which *is* official) is what to rely on.
11. **"Ten sections" on the ad-standards index → sixteen headings.** The six non-policy headings include the DSA transparency section the dossier missed entirely.
12. **§4.2's "five scenarios" is Meta's four bullets.** Substance identical; framing corrected so the doc doesn't misquote Meta's structure.
13. **Edit-to-re-review upgraded from ambiguous to definite.** *"These ads will be treated as new ads and reviewed by our ad review system"* (ad-standards index). Open question 6 narrowed to "does it keep delivering meanwhile".

### 15.3 Added — things the original missed

1. **§5.7 `AdSet.dsa_beneficiary` / `AdSet.dsa_payor` — the biggest gap.** Required on every ad set targeting the EU or associated territories; **the API returns a validation error without them**; ad-set-scoped; silently discarded outside the EU (so set them unconditionally); triggered afresh by new, duplicated *or significantly edited* ads; and the accuracy obligation runs for the ad's whole lifetime. A dossier that covers the AI Act, the TTPA SIEP ban and the DSA-adjacent `dsa_recommendations` edge but not this would have shipped an EU publisher that fails on its first `POST /adsets`.
2. **`effective_authorization_category` is also unavailable on Dynamic Ads.** The "Meta reclassified my ad as political" tripwire — which §5.6 calls the primary SIEP safety net — is blind on DPA/catalog campaigns. Added to §4.3 and gotcha 28.
3. **The `/policies/ad-standards/business-assets/*` pages are one-sentence pointers to Community Standards.** The §11 policy-drift crawler must target `transparency.meta.com/policies/community-standards/*` for these five, or it monitors nothing. Added to §1.9 and gotcha 29.
4. **`issues_info.level` values are documented loosely** — *"could be ad, ad set or campaign"*. The dossier writes `adset`; the wire token is not confirmed. Match case-insensitively on a normalised string rather than equality-testing `"adset"`.

### 15.4 Still unverified after this pass

- Whether third-party-AI detection is actually live, and on what date.
- The `ad_review_feedback` reason-code namespace (unchanged — only the two 2017 keys).
- `AdCreativeGenerativeAssetSpec.transparency_metadata` schema and writability (still typed `Object` in current SDK head — re-confirmed).
- Exact error codes for the EU SIEP prohibition (Meta declined to publish; confirmed again this pass — the developer blog says only *"update error handling appropriately"*).
- The 48-hour restriction-review SLA, the significant-edit/learning-phase page, and the ads-per-Page spend tiers — all behind JS-gated `facebook.com/business/help` pages that return no body text on either the `www.` or `m.` host. (`m.facebook.com/help/652738434773716` *does* render; `m.facebook.com/help/530209463124901` and `/316478108955072` do not. The `m.` trick is unreliable, not a general workaround.)
- Whether `synchronous_ad_review` runs any 2026-era classifier. The doc string still cites the retired 20%-text rule. Unmeasurable without live A/B data — the dossier's instruction to instrument precision/recall from day one stands and is the right call.
- Provenance of the retired "circumventing systems / disguise" wording.
- Any rejection-frequency statistic. None exists from Meta.
