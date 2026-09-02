# The autonomy engine: bandits, budget allocation and learning loops

**Compiled 2026-09-02. Meta Marketing API / Graph API v26.0 (released 2026-07-29, https://developers.facebook.com/docs/graph-api/changelog).**

Companion to the platform-mechanics dossiers in this directory:
`meta-api-foundations.md` (auth, versions, rate limits) · `meta-campaign-publishing.md` (object model, create paths, limits) · `meta-insights-measurement.md` (Insights API, attribution, settling) · `meta-optimization-controls.md` (rules, budget mechanics, CBO, learning phase, ad studies) · `meta-video-creative.md` · `creative-production-pipeline.md`.

**This document is the decision-science layer that sits on top of those.** It answers: given the constraints those documents establish, *what algorithm actually decides what to make, what to kill, and where to spend*, and how do you defend that algorithm's decisions at the sample sizes a real advertiser produces.

Every non-obvious claim carries a source URL. Meta platform facts are cross-referenced to the sibling dossiers rather than re-derived. Where a claim is reconstructed from memory or a secondary description rather than read from a primary source, it is marked **UNVERIFIED** or **[SECONDARY]**.

Notation: `θ` = conversion rate, `n` = trials, `c` = conversions, `E` = expected/observed conversion count, `b` = budget, `λ` = Lagrange multiplier (§8) or decay rate (§9) — disambiguated at use.

---

## 0. Executive summary — the ten decisions this document settles

| # | Question | Answer |
|---|---|---|
| 1 | Should our bandit allocate impressions between ads? | **No.** Meta already does this per-impression with information we do not have (§2, §5.1 of `meta-optimization-controls.md`). Our bandit allocates *existence* (which creatives are live) and *generation* (what to make next), not impressions. |
| 2 | Should our bandit allocate budget between ad sets? | **Only when CBO is off.** Under Advantage+ campaign budget, ad-set-level cost is a number Meta deliberately distorted; reallocating on it is the CBO death spiral. Act on the *campaign* budget instead. |
| 3 | Thompson sampling or UCB? | **Thompson sampling**, and specifically with posterior reshaping `α<1`. Chapelle & Li's own delayed-feedback table shows TS degrades ~2× less than UCB as feedback delay grows, and our delay is measured in *days*. |
| 4 | What is the reward? | **Not CVR.** Value per impression (or per dollar) under a fixed attribution window, modelled as a two-part (hurdle) process, with the delay-completion correction of §5 applied *before* any comparison. |
| 5 | What makes learning transfer to unseen creatives? | A **creative attribute vector** and a hierarchical logistic model whose attribute coefficients are pooled across ad sets, accounts and verticals (§4, §7). A per-ad Beta posterior learns nothing about creative #37. |
| 6 | What is the decision rule? | **Bayesian expected loss against a threshold of caring**, gated on minimum spend and minimum conversions, never a fixed-horizon p-value (§6). |
| 7 | How many conversions do we actually need? | **~470 per arm** to detect a 20 % relative CPA difference at 80 % power / 5 % two-sided. At 50 conversions/arm — Meta's own learning-phase threshold — the minimum detectable difference is **+75 %** (§6.4). This single table determines the whole product's tiering. |
| 8 | How do we know the automation is working? | **Not from before/after.** Gordon et al. (Facebook's own data) showed observational methods fail to recover experimental effects. Use paired switchbacks pooled across accounts, geo holdouts (GeoLift), or account-level randomisation once the fleet is large enough (§11). |
| 9 | What does the LLM do? | **Proposes hypotheses and writes creative specs. It never touches budget, never declares a winner, and never asserts causality.** Its output is a typed, pre-registered hypothesis object that the statistics layer accepts or rejects (§10). |
| 10 | What is the single most dangerous failure mode? | **Age-confounded early killing.** A 2-day-old ad has ~55 % of its conversions reported; a 7-day-old ad has ~95 %. Comparing them directly systematically kills new creative, which is exactly the creative the generator just made. This bug looks like "the AI keeps rejecting its own work" and it is a data bug, not a model bug (§5.4). |

---

## 1. The environment: why this is not a textbook bandit

Every off-the-shelf bandit result assumes things that are false here. Enumerate them before choosing an algorithm.

| Textbook assumption | Reality on Meta | Consequence |
|---|---|---|
| The learner chooses the arm and observes the pull | Meta's delivery system chooses which ad is shown to which person; we choose only which ads *exist* and with what budget | Our action space is `{create, pause, budget}`, not `{show ad A}`. Propensities for the impression-level decision are unobservable → impression-level IPS/OPE is unidentified (§11.1) |
| Reward is observed immediately | Purchases arrive hours to weeks later; the row for `date_start = D` stays mutable for **28 days** (*"Insights refresh every 15 minutes and do not change after 28 days of being reported"* — https://developers.facebook.com/docs/marketing-api/insights/best-practices/) | Every comparison is between partially-observed cohorts (§5) |
| Reward is stationary | Creative fatigue, auction seasonality, competitor entry, audience saturation | Discounted / windowed posteriors + change-point detection (§9) |
| Arms are exchangeable and finite | Creatives are generated on demand from a combinatorial attribute space; the interesting arms do not exist yet | Contextual bandit over attributes, not a per-arm bandit (§4) |
| Pulling an arm is free | Adding an ad to a live ad set is a **significant edit** that restarts the learning phase for the whole ad set (https://www.facebook.com/business/help/316478108955072) | Actions have a *reset cost*; batch them (§2.4) |
| Actions are reversible | The 175 % daily overspend ceiling anchors to the **highest** budget set that day — writing a big budget then writing it back does not undo it (https://www.facebook.com/business/help/190490051321426) | Upward budget writes are irreversible within the calendar day (§8.6) |
| Data can be analysed with standard estimators | Data is adaptively collected by *two* nested adaptive policies (ours and Meta's) | OLS/IPW are not asymptotically normal on bandit-collected data (Zhang, Janson & Murphy, NeurIPS 2020, https://arxiv.org/abs/2002.03217); need BOLS / adaptively-weighted AIPW (Hadad et al., https://arxiv.org/abs/1911.02768) |

### 1.1 The reward is expensive and the noise is enormous

The economic ceiling on everything in this document is Lewis & Rao's result: across 25 large field experiments representing **$2.8 M of digital advertising spend**, *"the median confidence interval on return on investment is over 100 percentage points wide"*, because individual-level sales have a coefficient of variation around 10, so an informative experiment can require *"over 10 person-weeks"* of data.
Source: Randall A. Lewis & Justin M. Rao, "The Unfavorable Economics of Measuring the Returns to Advertising", *Quarterly Journal of Economics* 130(4), 2015. https://doi.org/10.1093/qje/qjv023

> **Design implication.** Do not build a system whose value proposition is "we will prove which creative is better." At typical SMB budgets you cannot. Build a system whose value proposition is **"we will make good-enough decisions fast, cheaply, and continuously, and we will be honest about the residual uncertainty."** That is a regret-minimisation product, not a hypothesis-testing product. Every design choice below follows from that.

### 1.2 The three clocks

An autonomous loop that ignores the clock mismatch will thrash.

| Clock | Period | Set by |
|---|---|---|
| Meta's within-ad-set impression allocation | per auction (milliseconds) | Meta |
| Insights write cadence | **~15 min** (https://developers.facebook.com/docs/marketing-api/insights/best-practices/) | Meta |
| Conversion settling | 1–7 days for `1d_click`/`7d_click`; row mutable 28 days | user behaviour + Meta |
| Learning phase | **~50 optimisation events / 7 days** per ad set since last significant edit (https://www.facebook.com/business/help/112167992830700) | Meta |
| Meta's stated safe edit cadence | *"limit yourself to 2-3 times a day and only the early part of the day"* (https://developers.facebook.com/docs/marketing-api/bidding/overview/pacing-and-scheduling) | Meta |
| Our decision loop | **daily for budget, weekly for creative** | us |

The slowest clock governs. A creative decision cannot be made faster than the conversion-settling clock, and a *structural* decision (new ad set) cannot be made faster than the learning-phase clock. Any product roadmap promising "hourly optimisation" of creative is promising to amplify noise.

---

## 2. The nested-bandit problem, and the layer contract

### 2.1 Meta's delivery system is already a bandit, and it is better than yours at its job

Meta's auction picks the ad with the highest **total value**, which it defines as three components: *"Bid… Estimated action rates: An estimate of whether a particular person engages with or converts from a particular ad… Ad quality"*, and *"the winner of the auction is the ad with the highest total value, subject to a price floor (minimum price)"*.
Source: https://www.facebook.com/business/help/430291176997542 (retrieved through a text-extraction proxy; the page is JS-rendered)

Inside an ad set, Meta explicitly concentrates: when one ad outperforms, Meta *"will run that ad more frequently to get better performance for your budget"*, and Meta's own suggested remedy for even distribution is *"To make your ads run more evenly, you can try putting each ad in its own ad set."*
Source: https://www.facebook.com/business/help/464145940405064 (see `meta-optimization-controls.md` §5.1)

So inside every ad set there is already a contextual bandit with:
- **per-impression** decision granularity (ours is daily — 10⁵× faster),
- **per-user context** (age, behaviour, session, device) that we never see,
- an estimated-action-rate model trained on the entire platform's data,
- and it is optimising the `optimization_goal` we configured.

You will not beat it at impression allocation. Three failure modes follow from trying.

### 2.2 The three ways two bandits cancel out

**(a) Amplification / premature convergence.** Meta concentrates spend on ad A because of early noise. We read ad-level spend or CPA, conclude A is the winner, and pause B and C. We have now converted Meta's *provisional* exploitation into an *irreversible* structural decision, on far less evidence than Meta used, and we have destroyed the portfolio that protects us against A's fatigue two weeks later. The observable symptom: portfolios collapse to one creative, then CPA cliffs.

**(b) Fighting.** We force even exposure — `execution_type: ROTATE` (which *"Pauses the currently active ad, and activates the next ad by ID in the ad set"*, i.e. round-robin, performance-blind — https://developers.facebook.com/docs/marketing-api/ad-rules/overview/execution-spec/), or ad-set `daily_spend_cap` under CBO, or dayparting. Each of these overrides an optimiser with strictly more information. Meta says so directly about spend limits: they *"may be useful if you have specific budget requirements"* but restrict the algorithm's flexibility (https://www.facebook.com/business/help/458847204894307). Expected outcome: worse CPA than doing nothing, plus a learning-phase reset.

**(c) Confounding.** Ad-level CPA inside a shared ad set is not a creative effect. The impressions were assigned by a policy that conditioned on early outcomes. This is the classic winner's-curse / adaptively-collected-data problem: OLS on bandit-collected data is not asymptotically normal, and naive reliance on it *"can lead to Type-1 error inflation and confidence intervals with below-nominal coverage probabilities"* (Zhang, Janson & Murphy, https://arxiv.org/abs/2002.03217).

Under Advantage+ campaign budget the same argument applies one level up: Meta's own instruction is *"when you use Advantage+ campaign budget, it's important to analyze results at the campaign level, rather than at the ad set level"* (https://developers.facebook.com/docs/marketing-api/bidding/guides/advantage-campaign-budget/).

### 2.3 The delegation contract

This table is the architectural core of the whole build. Print it and put it in the repo README.

| Decision | Owner | Why | Our API surface |
|---|---|---|---|
| Which user sees which ad, right now | **Meta** | per-impression context we cannot see | none — do not touch |
| Which ad in an ad set gets the next impression | **Meta** | same | none — no `ROTATE`, no ad-level pausing for "rotation" |
| Placement mix (Feed / Reels / Stories / Audience Network) | **Meta** | Advantage+ placements; Meta's own best practice is all placements or *"at least 6+"* (https://www.facebook.com/business/help/950694752295474) | `targeting.publisher_platforms` left unset |
| Audience expansion beyond our seed | **Meta** | Advantage+ audience | leave on |
| Budget split *between* ad sets in a CBO campaign | **Meta** | pacing happens at campaign level under CBO | none — never set `daily_spend_cap` |
| **Which creatives exist** (launch / pause / archive) | **us** | Meta cannot generate creative or reason about a business | `POST /act_{id}/adcreatives`, `POST /act_{id}/ads`, `POST /{ad_id}` `status` |
| **What creative to generate next** | **us** | this is the only irreplaceable decision | generation pipeline |
| **Campaign-level total budget** | **us** | Meta optimises *within* a budget; the budget itself is a business decision | `POST /{campaign_id}` `daily_budget` |
| **Which structural experiments to run** | **us** | Meta's A/B tool *"does not make any automatic changes based on the results"* (https://www.facebook.com/business/help/1423851372208214) | `ad_studies`, or our own sibling campaigns |
| **Kill switches and spend guards** | **us** | Meta will happily spend to the cap | `spend_cap`, `status=PAUSED` |

### 2.4 Structuring so the two bandits *compose* instead of colliding

The rule: **our decision unit must be a unit Meta does not reallocate across.**

- Meta reallocates *within* an ad set → ad-level reads inside a shared ad set are exploitation signal, not evaluation signal.
- Meta reallocates *between* ad sets when CBO is on → ad-set-level reads under CBO are not evaluation signal either.
- Meta does **not** reallocate between campaigns → **campaign is the smallest unit at which an unconfounded read is free.**

That gives three legitimate structures, and their costs:

| Structure | Unconfounded read at | Cost | When |
|---|---|---|---|
| **S1: one consolidated CBO campaign, 1–3 ad sets, 3–6 ads each** | campaign only | cheapest, fastest learning | default; < ~$2k/week |
| **S2: one ad set per creative concept, ABO (ad-set budgets), one campaign** | ad set | each cell needs ~50 events/7 days to be stable (`learning_stage_info`); at $40 CPA that is $2,000/cell/week | ~$2k–$8k/week, and only for *concept*-level tests |
| **S3: sibling campaigns, one per arm, equal daily budget, mutually exclusive audiences** | campaign | most expensive, but the only structure where Meta's optimiser is fully inside each arm and cannot leak across | > ~$8k/week, or whenever the result must be defensible |

The arithmetic that forces this tiering is in `meta-optimization-controls.md` §7.5 and is repeated here because it is the single most important number in the product: **a valid cell needs ~50 optimisation events in 7 days; at a $40 CPA that is $2,000 per cell per week.** Four cells is $8,000/week *before* you get one read. Below that, splitting into cells does not buy rigour — it buys four `learning_stage_info.status = FAIL` ad sets whose numbers are noise.

### 2.5 The trick: use Meta's allocation as a free, low-variance surrogate reward

This is the most useful non-obvious idea in this section.

Inside a shared ad set, Meta's impression allocation is *Meta's posterior over which ad is best, revealed*. It is computed from vastly more data than we have, updated per-auction, and it is **available at impression scale rather than conversion scale** — thousands of observations where we have tens.

Define, for ad `a` in ad set `s` over window `w`:

```
share_a = impressions_a / Σ_{a' ∈ s} impressions_{a'}
```

Properties:
- **Fast.** Meaningful within 24–48 h, long before conversions settle.
- **Low variance.** Based on 10³–10⁶ impressions, not 10–50 conversions.
- **Aligned.** Meta is optimising the `optimization_goal` we set — if that is `OFFSITE_CONVERSIONS` with a purchase event, share is Meta's estimate of relative purchase propensity per dollar.

And its failure modes, which must be encoded:
- **It is not incremental.** Meta's estimate includes people who would have converted anyway.
- **It is self-fulfilling.** An ad starved at hour 6 never recovers, so share at day 7 partly reflects share at day 1.
- **It is objective-relative.** If `optimization_goal` is `LINK_CLICKS`, share tells you nothing about purchases.
- **It saturates.** Share → 0.95 tells you A > B but not by how much.

**Correct use:** treat `share` as a *surrogate outcome* in the Prentice sense — validate it, do not assume it. Concretely: maintain a per-account regression of realised 7-day CPA rank on day-2 impression share rank; store the rank correlation (Kendall's τ). Use share for *cheap early triage* (retire an ad below 3 % share after 72 h — Meta has already stopped serving it, so pausing costs nothing and only recovers an ad slot) and use conversions for *anything that changes budget*. Log τ per account; if τ < 0.3 the surrogate is not working for that account and triage must fall back to spend gates.

> **Why "pause the starved ad" is nearly free.** If an ad is receiving 2 % of ad-set impressions, pausing it removes ~2 % of the ad set's delivery. But it *is* an ad-set composition change and therefore a significant edit (§2.6). So: never trickle. Batch all pauses and adds into one weekly maintenance window.

### 2.6 The reset cost, quantified

Meta's significant-edit list (verbatim, https://www.facebook.com/business/help/316478108955072) includes *"Introduction of additional ads in the ad set"* and *"Updates to creative assets or ad content"* under **always restarts learning**. Budget changes are under **may restart, depending on magnitude**, with the only quantitative guidance being *"if you increase your budget from $100 to $101, that isn't likely… However, if you change your budget from $100 to $1000, one or more ad sets may reenter the learning phase."*

Model the reset cost explicitly in the decision:

```
cost_of_action(a) ≈ E[extra_spend_during_relearning]
                  ≈ days_to_exit × daily_budget × (CPA_learning / CPA_stable − 1)
```

with `days_to_exit ≈ max(dynamic_lp_days_threshold, 50 / expected_daily_conversions)` read from `learning_stage_info` on the ad set node:

```
GET /v26.0/{ADSET_ID}?fields=learning_stage_info{status,conversions,last_sig_edit_ts,
    attribution_windows,dynamic_lp_status,dynamic_lp_conversions_threshold,dynamic_lp_days_threshold}
```
`status ∈ {LEARNING, SUCCESS, FAIL}`; **`FAIL` means "Learning limited", not an error.**
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-learning-stage-info/

A bandit that does not carry this cost term will churn creative weekly and keep every ad set permanently in learning — the most common way an "AI ads platform" underperforms a human who changes nothing.

**Measure, don't guess, whether an edit was significant:** write the edit, then re-read `learning_stage_info.last_sig_edit_ts`. If the timestamp moved, it was significant. This converts the folklore "20 % budget rule" (which appears in every blog and in none of Meta's documentation) into a measurement.

---

## 3. The bandit core: what the reward is, and how to update it

### 3.1 Do not make CVR the reward

The naive design — Beta-Binomial on conversions/clicks, Thompson-sample, pick the winner — is wrong for four independent reasons:

1. **CVR is not the objective.** The objective is profit, which is `value − spend`. A creative with 3 % CVR and $3.00 CPC loses to one with 2 % CVR and $1.20 CPC. Optimising CVR optimises the landing page, not the ad.
2. **The denominator is chosen by Meta.** Clicks are not assigned; Meta decided who to show the ad to. Conditioning on click makes the comparison a *post-treatment* conditioning — a collider. Two ads with identical true quality can show different click-conditional CVR purely because Meta sent them different traffic.
3. **Purchase value is not Bernoulli.** For e-commerce, `action_values` is heavy-tailed; a single $900 order swamps forty $40 orders. Binary modelling throws away the variable that matters.
4. **The attribution window changes the reward.** `7d_click` and `1d_view` are different random variables. See `meta-insights-measurement.md` §4 — `7d_view`/`28d_view` return **no data since 2026-01-12**, and click-through attribution narrowed to link clicks only from **March 2026**, with the residue moving into engage-through (`1d_ev`) and the video engaged-view threshold dropping from 10 s to 5 s (https://www.facebook.com/business/news/click-attribution).

### 3.2 The reward definitions that actually work

Define these once, in one place, and never let a second definition into the codebase.

```python
# Canonical reward definitions. window is one of: "7d_click", "1d_click", "sum_7dclick_1dev_1dview"
# All money in account-currency MINOR UNITS (integers). Never float-compare.

REWARD_KIND = "value_per_impression"   # or "value_per_dollar" / "neg_cpa"

def conversions(row, window):          # exactly ONE action_type. Never sum the array.
    for a in row["actions"]:
        if a["action_type"] == PRIMARY_ACTION_TYPE:      # e.g. "offsite_conversion.fb_pixel_purchase"
            return int(a.get(window, 0))
    return 0

def value(row, window):
    for a in row["action_values"]:
        if a["action_type"] == PRIMARY_ACTION_TYPE:
            return to_minor_units(a.get(window, 0))
    return 0
```

> **The single biggest parsing mistake in this whole system** (from `meta-insights-measurement.md` §2.3): summing `actions[].value`. The array contains overlapping roll-ups — `purchase` and `omni_purchase` aggregate over `offsite_conversion.fb_pixel_purchase`, `app_custom_event.fb_mobile_purchase`, `onsite_web_purchase`, `offline_conversion.purchase`. Adding them double- or triple-counts. Pick exactly one `action_type` per KPI and hard-code it.

**Three reward scales, three model families:**

| Objective | Reward variable | Model | Conjugate? |
|---|---|---|---|
| Lead-gen / app install (fixed value per event) | conversions per impression | **Poisson–Gamma** (rate per 1000 impressions) or Beta–Binomial on conv/click | yes |
| E-commerce, CPA target | conversions per **dollar** | Poisson–Gamma with exposure = spend | yes |
| E-commerce, ROAS target | value per dollar | **Two-part (hurdle)**: Poisson–Gamma for count × Log-normal or Gamma for value-given-conversion | approximately |

**Why Poisson–Gamma with a spend exposure is usually the right default.** Meta assigns impressions, not clicks or users; and spend, not impressions, is the resource we control. Model:

```
c_a  ~ Poisson(θ_a · s_a)              # c_a = conversions attributed to ad a, s_a = spend (dollars)
θ_a  ~ Gamma(shape = k₀, rate = r₀)    # θ_a = conversions per dollar  ⇒  CPA_a = 1/θ_a
                                       # prior mean = k₀/r₀ ;  r₀ has UNITS OF DOLLARS
posterior:  θ_a | data ~ Gamma(shape = k₀ + c_a,  rate = r₀ + s_a)
posterior on CPA:      1/θ_a ~ InverseGamma(k₀ + c_a, r₀ + s_a)
```
(Everything below uses the **shape–rate** parameterisation. Getting this backwards — passing a rate where your library wants a scale — inverts the prior strength and is a genuinely hard bug to spot, because the posterior still looks plausible.)

This is exactly conjugate, has the right support (a rate, not a probability), naturally handles unequal exposure between ads (which the Binomial does not, because the "trials" are not comparable across ads), and gives a posterior on CPA directly as an inverse-Gamma.

Prior elicitation is easy and defensible: set `r₀ = s₀` (the prior is worth `s₀` dollars of spend) and `k₀ = s₀ / CPA_target` (so the prior mean is exactly `1/CPA_target`). **`s₀ = 1 × target CPA` — one prior conversion's worth of spend, i.e. `k₀ = 1`, `r₀ = CPA_target` — is a good default** — weak enough not to dominate, strong enough to stop a 1-conversion ad from claiming a $4 CPA.

**Two-part model for ROAS.** Do not model ROAS directly (it is a ratio of two noisy quantities with a mass at zero and a heavy right tail). Model:

```
count:  c_a  ~ Poisson(θ_a · s_a),        θ_a ~ Gamma(k, ϑ)
value:  v_ij ~ LogNormal(μ_a, σ²),        μ_a ~ Normal(μ_0, τ²)   # per-conversion order value
ROAS_a = θ_a · E[v] = θ_a · exp(μ_a + σ²/2)
```
Posterior draws of ROAS come free by drawing `θ_a` and `μ_a` jointly. This is the model that prevents the classic disaster where one $2,000 B2B order makes a bad creative look like a 9× ROAS winner for three weeks.

**UNVERIFIED / practical caveat:** if you compute ROAS yourself as `action_values / spend` it will not exactly match Meta's `purchase_roas` field, because the numerator's value-dedup rules differ (`meta-insights-measurement.md` §2.4). Pick one and never mix them in the same decision surface.

### 3.3 Thompson sampling, stated precisely

Thompson sampling ("randomized probability matching") *"randomly allocates observations to arms according the Bayesian posterior probability each arm is optimal"* — Steven L. Scott, "A modern Bayesian look at the multi-armed bandit", *Applied Stochastic Models in Business and Industry* 26(6):639–658, 2010. https://doi.org/10.1002/asmb.874

Chapelle & Li's empirical evaluation is the canonical practitioner reference: *"one of oldest heuristic to address the exploration/exploitation trade-off"*, shown "highly competitive" and advocated as a standard baseline.
Source: Olivier Chapelle & Lihong Li, "An Empirical Evaluation of Thompson Sampling", NIPS 2011. https://proceedings.neurips.cc/paper_files/paper/2011/hash/e53a0a2978c28872a4505bdb51db06dc-Abstract.html

For our Gamma–Poisson formulation, the daily allocation step is:

```python
def thompson_allocate(ads, budget, alpha_reshape=0.5, n_draws=4000):
    """Return the fraction of `budget` each ad should be eligible for.
       NOTE: under CBO this is used to decide EXISTENCE and campaign-level budget,
       not per-ad spend. See §2.3."""
    wins = {a.id: 0 for a in ads}
    for _ in range(n_draws):
        best, best_val = None, -inf
        for a in ads:
            # posterior over conversions-per-dollar, reshaped (see §3.5)
            k_post = (a.prior_k + a.conversions_corrected) / alpha_reshape
            r_post = (a.prior_rate + a.spend) / alpha_reshape
            theta  = gamma_sample(shape=k_post, rate=r_post)
            if theta > best_val:
                best, best_val = a.id, theta
        wins[best] += 1
    return {aid: w / n_draws for aid, w in wins.items()}
```

The output `p_a = P(ad a is the best)` is the quantity you (a) allocate on, (b) **log as the propensity** for later off-policy evaluation (§11.1), and (c) show the user as "confidence this is the winner".

### 3.4 Posterior reshaping: the parameter almost nobody sets, and should

Chapelle & Li tested dividing the Beta posterior parameters by a factor α — *"we have tried to change it to parameters a/α, b/α. Doing so does not change the posterior mean, but multiply its variance by a factor close to α²."* Their finding, verbatim:

> *"Values of α smaller than 1 decrease the amount of exploration and often result in lower regret. But the price to pay is a higher variance: in some runs, the regret is very large. The average regret is asymptotically not as good as with α = 1, but tends to be better in the non-asymptotic regime."*

And on real display-advertising data (Table 2, CTR regret %, lower is better):

| Method | TS α=0.25 | TS α=0.5 | TS α=1 | LinUCB α=0.5 | LinUCB α=1 | LinUCB α=2 | ε-greedy .005 | ε .01 | ε .02 | Exploit | Random |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Regret (%) | 4.45 | **3.72** | 3.81 | 4.99 | 4.22 | 4.14 | 5.05 | 4.98 | 5.22 | 5.00 | 31.95 |

Source: Chapelle & Li 2011, §4, Table 2 (text extracted from the NIPS PDF).

**Read the direction carefully.** The parameters are *divided* by α. So α < 1 makes the posterior parameters **larger**, which makes the posterior **narrower**, which means **less** exploration. (The paper states the variance is multiplied by "a factor close to α²"; for a Beta with large a+b the exact scaling is closer to α — either way, α<1 shrinks it.) `α = 0.5` was the best setting on their real display-advertising data.

**Why this matters more for us than for them.** We are permanently in the non-asymptotic regime — an account runs 20–200 creatives *ever*, not 10⁷ pulls, and every unit of exploration is paid for in real money at full CPA. Set `alpha_reshape` as an explicit, per-account, tunable knob, default `0.5`, and expose it as "exploration aggressiveness". Also record their warning: **lower α means fatter tails on the regret distribution** — occasionally you converge hard onto a bad creative. Pair `α<1` with the forced-exploration floor of §8.3.

**Optimistic Thompson sampling** (May et al., cited by Chapelle & Li as [11]) replaces the sampled score with `max(sampled, posterior mean)` — never sample *below* the mean. Chapelle & Li: *"Optimistic Thompson sampling achieves a slightly better regret, but the gain is marginal."* Not worth the complexity here.

### 3.5 Why Thompson sampling and not UCB — the delay argument

This is the decisive empirical result for our setting. Chapelle & Li simulated feedback arriving only every δ steps (Table 1, regret at T = 10⁶, 100 repetitions, 10 dynamic items):

| δ (steps between feedback batches) | 1 | 3 | 10 | 32 | 100 | 316 | 1000 |
|---|---|---|---|---|---|---|---|
| **UCB** regret | 24,145 | 24,695 | 25,662 | 28,148 | 37,141 | 77,687 | 226,220 |
| **TS** regret | 9,105 | 9,199 | 9,049 | 9,451 | 11,550 | 21,594 | 59,256 |
| Ratio UCB/TS | 2.65 | 2.68 | 2.84 | 2.98 | 3.22 | 3.60 | **3.82** |

Their explanation, verbatim: *"Thompson sampling alleviates the influence of delayed feedback by randomizing over actions; on the other hand, UCB is deterministic and suffers a larger regret in case of a sub-optimal choice."*

They repeated it on Yahoo! front-page news data with update delays of **{10, 30, 60} minutes**: *"(optimistic) Thompson sampling appears competitive across all delays. While the deterministic UCB works well with short delay…"* — i.e. UCB degrades and TS does not.

> **Our delay is not 60 minutes. It is 1–7 days.** We are far off the right edge of that table. Deterministic index policies (UCB, greedy-with-tiebreak) will repeatedly re-pick the same arm across an entire settling window because nothing in their input changed. **Thompson sampling's randomisation is not a nicety here; it is the mechanism that keeps exploration alive across a multi-day observation lag.** This is the single strongest algorithmic argument in this document.

Secondary argument: TS composes with batching. Our decisions are made once per day over a batch of new data; TS is well-defined for that ("draw once per decision"), whereas UCB's confidence widths were derived for per-pull updates.

### 3.6 Where a UCB-family method is still the right tool

Use a deterministic upper-confidence rule for **guardrails and kill decisions**, not for allocation:

- "Pause ad `a` if the **upper** 90 % credible bound on its CPA is still worse than the incumbent's **lower** bound" is a defensible, deterministic, explainable rule. Reviewers and advertisers understand intervals; they do not understand a random draw.
- KL-UCB / Bernoulli-KL bounds are tighter than Hoeffding at small `n` and low `p`, which is exactly our regime. But at n ≈ 50 conversions the difference between KL-UCB and a Jeffreys-prior credible interval is negligible relative to the delay bias of §5. **Spend your engineering budget on the delay correction, not on the concentration inequality.**

### 3.7 The exploit-only baseline is much stronger than you expect

Chapelle & Li's display-advertising table shows **Exploit-only at 5.00 % regret vs Random at 31.95 %**, and their explanation is important for us: *"A possible explanation is that the change in context induces some exploration."* And: *"the fact that exploit-only is so much better than random might explain why ε-greedy does not beat it: whenever this strategy chooses a random action, it suffers a large regret in average which is not compensated by its exploration benefit."*

**Implication for our product:** ε-greedy over *creatives* is a bad design — a randomly-chosen bad creative burns real money at full CPA. Exploration must be (a) posterior-weighted (TS), and (b) *budgeted* (a fixed exploration allocation, §8.3), not probabilistic per-decision. And a substantial part of our "exploration" is free: because the audience and auction context change continuously, and because Meta re-explores inside each ad set, an exploit-only creative policy still receives fresh information.

---

## 4. Contextual bandits over creative attributes — the part that makes it "understand", not just "pick"

A per-ad Beta or Gamma posterior learns nothing about creative #37 before it runs. The entire difference between "picks the winner" and "understands how to perform better" is whether the model's parameters live on **attributes** rather than on **ad IDs**.

### 4.1 The creative attribute vector is the most important schema in the system

This must be produced at **generation time** by the pipeline that made the video (it knows the truth), and independently *verified* post-hoc from the rendered asset where possible. Never let an LLM infer attributes from a finished video and treat that as ground truth — it is the same model that wrote the brief, so its labels are correlated with its intentions, not with the pixels.

A workable schema (this is a design proposal, not something Meta publishes):

```jsonc
{
  "creative_id": "cr_01J...",
  "structural": {
    "duration_s": 21,
    "aspect_ratio": "9:16",            // 9:16 | 1:1 | 4:5 | 16:9
    "n_cuts": 7,
    "avg_shot_len_s": 3.0,
    "first_cut_at_s": 1.2,
    "has_captions": true,
    "caption_style": "karaoke",        // none | static | karaoke | boxed
    "audio": "vo_plus_music",          // silent | music | vo | vo_plus_music
    "music_bpm_bucket": "120_140",
    "voice_gender": "female",
    "voice_pace_wpm": 168
  },
  "content": {
    "hook_archetype": "problem_agitate",   // controlled vocabulary, ~12 values
    "hook_modality": "spoken_question",
    "product_first_frame_s": 2.4,
    "n_benefit_claims": 3,
    "social_proof": "review_quote",        // none | ugc | review_quote | stat | authority
    "offer_type": "percent_off",           // none | percent_off | bundle | free_ship | trial
    "cta_style": "spoken_and_supered",
    "cta_at_s": 17,
    "human_presence": "single_presenter",  // none | hands_only | single_presenter | group
    "setting": "home_interior",
    "colour_temp": "warm",
    "text_density_pct": 18
  },
  "provenance": {
    "generator": "veo-3.x | seedance | ...",
    "prompt_hash": "sha256:...",
    "parent_creative_id": "cr_01H...",     // lineage for the hypothesis loop
    "hypothesis_id": "hy_0042",
    "assignment": "randomised"             // randomised | exploit | human_override
  }
}
```

Design rules that are easy to get wrong:
- **Controlled vocabularies, versioned.** `hook_archetype` must be an enum with a version stamp. If the LLM invents a 13th archetype next month, the coefficient for archetype 12 silently changes meaning.
- **Every field must be *choosable* by the generator.** An attribute you cannot deliberately set is a covariate, not a lever. Keep the two sets separate in the schema (`levers` vs `observed`) — you can only *act* on levers.
- **Store the `assignment` field.** Whether this creative's attributes were sampled by the policy or forced-randomised is what makes §4.5 possible. Without it, you can never estimate an attribute effect.
- **Store lineage.** `parent_creative_id` plus `hypothesis_id` is what lets you say "we changed exactly one thing" and is what the reflection loop reads (§10).

### 4.2 The model: Bayesian logistic / Poisson regression with a Laplace posterior

Chapelle & Li's Algorithm 3 is the production-grade recipe, and it is worth reproducing verbatim because it is compact, streaming, and gives you both the point estimate and the posterior you need for Thompson sampling:

> **Algorithm 3: Regularized logistic regression with batch updates**
> Require: Regularization parameter λ > 0.
> `m_i = 0 ; q_i = λ` { Each weight `w_i` has an independent prior `N(m_i, q_i^{-1})` }
> for t = 1, …, T do
>   Get a new batch of training data `(x_j, y_j), j = 1..n`.
>   Find `w` as the minimizer of: `½ Σ_i q_i (w_i − m_i)² + Σ_j log(1 + exp(−y_j w^T x_j))`
>   `m_i = w_i`
>   `q_i = q_i + Σ_j x_ij² p_j (1 − p_j)`, where `p_j = (1 + exp(−w^T x_j))^{-1}`  { Laplace approximation }
> end for

Source: Chapelle & Li, NIPS 2011, Algorithm 3 (text extracted from the NIPS PDF).

Properties that make this the right choice for us:
- **Streaming and stateless-friendly.** The posterior at time *t* becomes the prior at *t+1*. You store `2d` floats, not the history.
- **Diagonal covariance, and that is fine.** Their calibration check: *"The diagonal Gaussian approximation of the posterior does not seem to harm the variance predictions. In particular, they are very well calibrated: when constructing a 95 % confidence interval for CTR, the true CTR is in this interval 95.1 % of the time."* That is a remarkable empirical result and it justifies not building a full-covariance model.
- **Thompson sampling is one line:** draw `w̃_i ~ N(m_i, q_i^{-1})` independently, score every candidate creative with `w̃`, pick the argmax.
- **LinUCB is also one line, for the explainable path:** Chapelle & Li state it as selecting the ad maximising `Σ_i m_i x_i + α · sqrt(Σ_i q_i^{-1} x_i²)`.

For our Poisson/rate reward, replace the logistic loss with a Poisson log-likelihood with `log(spend)` as an offset; the Laplace update becomes `q_i ← q_i + Σ_j x_ij² μ_j` with `μ_j = exp(w^T x_j + log s_j)`. Same structure, same streaming property.

**Regret guarantee for the linear-payoff TS variant:** Õ(d^{3/2}√T) — Agrawal & Goyal, "Thompson Sampling for Contextual Bandits with Linear Payoffs", https://arxiv.org/abs/1209.3352. Treat this as reassurance that the algorithm is not pathological, not as a planning number: `T` here counts impressions we do not control and `d` is our attribute dimension, so the bound is astronomically loose in practice.

**LinUCB's own provenance and effect size:** Li, Chu, Langford & Schapire, "A Contextual-Bandit Approach to Personalized News Article Recommendation", WWW 2010, reported *"12.5 % click lift compared to a standard context-free bandit algorithm"* on 33 M Yahoo! front-page events, *"with greater advantages emerging when training data becomes limited"*. https://arxiv.org/abs/1003.0146 — that last clause is our regime exactly.

### 4.3 Interactions: creatives are combinations, and the interactions are the interesting part

`hook_archetype = problem_agitate` may work only when `duration ≤ 20 s` and `social_proof = ugc`. A main-effects-only linear model will never find that, and the full interaction space is combinatorial.

Two production-proven approaches:

**(a) Factorisation / low-rank interactions.** The AutoCO framework at Alibaba models creative-element interactions by extending factorisation machines to *"more complex than the inner product"* interaction functions, found via *"one-shot search algorithms"* motivated by AutoML, and handles exploration with *"stochastic variational inference with the reparameterization trick to estimate parameter distributions, combined with Thompson Sampling"*. Reported online result: **~7 % CTR increase vs baseline** in A/B test at Alibaba scale.
Source: Chen, Xu, Jiang, Ge, Zhang, Lian, Zheng, "Automated Creative Optimization for E-Commerce Advertising", The Web Conference (WWW) 2021. https://arxiv.org/abs/2103.00436

**(b) Hill-climbing over the combinatorial layout space.** Hill, Nassif, Liu, Iyer & Vishwanathan, "An Efficient Bandit Algorithm for Realtime Multivariate Optimization", KDD 2017, explicitly models *"possible interactions between different components of the page"* and uses hill-climbing to select combinations without enumerating them. Reported: *"After only a single week of online optimization, we saw a 21 % conversion increase compared to the median layout."* https://arxiv.org/abs/1810.09558

**What to build first.** Main effects + a hand-curated shortlist of ~15 two-way interactions (hook × duration, hook × social_proof, offer × audience_temp, captions × placement) as explicit product features in `x`. Move to a factorised model only once you have >2,000 creative-weeks of data across the fleet. A d≈120 sparse binary vector with 15 crafted interactions is learnable from hundreds of creatives; a full FM is not.

### 4.4 Cold start: priors from a creative-attribute regression

A brand-new creative has no data. Its prior comes from the attribute model, not from a default:

```
E[log θ_new]  = m^T x_new                                  # posterior mean of the attribute model
Var[log θ_new] = Σ_i q_i^{-1} x_new,i²  +  σ²_ad           # attribute uncertainty + irreducible ad-level variance
```

`σ²_ad` is the *residual* ad-level variance after attributes — estimate it from the hierarchical model (§7) as the variance of the per-ad random intercept. It is essential: without it the model believes it can predict a creative's performance from its metadata, which it cannot. Empirically, in every published creative-effect study the residual dominates the explained variance; budget for `σ²_ad` to be **larger** than the attribute-explained variance and you will be right more often than not. **UNVERIFIED:** I have no public source giving the R² of creative-attribute models on Meta conversion outcomes; treat any claim of high explanatory power as a red flag.

Translate the log-normal prior into the Gamma prior of §3.2 by moment-matching, then let the ad's own data take over. The half-life is short: with `s₀` equal to one target-CPA of prior strength, the attribute prior is outweighed after ~2 conversions.

> **The right expectation to set with users:** the attribute model does not predict which creative wins. It shifts the *starting position* of new creatives and it tells the generator which region of design space to sample from. That is worth a lot at 10 creatives/month and almost nothing at 10,000.

### 4.5 The identification problem, and the forced-randomisation budget

This is where most "AI learns what creative works" systems are quietly broken.

The generator (an LLM) proposes creative attributes. If it proposes `hook=problem_agitate` mostly for supplement brands and `hook=demo` mostly for kitchenware, then the coefficient on `problem_agitate` is confounded with vertical. Worse: if it proposes `problem_agitate` more often *after* seeing that it worked, the attribute distribution is now a function of past outcomes — the classic adaptively-collected-data problem, where standard estimators lose asymptotic normality (Zhang, Janson & Murphy, https://arxiv.org/abs/2002.03217) and IPW estimators become *"skewed and heavy-tailed as the propensity scores decay to zero"* (Hadad, Hirshberg, Zhan, Wager & Athey, "Confidence Intervals for Policy Evaluation in Adaptive Experiments", https://arxiv.org/abs/1911.02768).

Three mechanisms, all required:

**1. A forced-randomisation slice.** A fixed fraction of each period's new creatives (default **20 %**, floor of 1 creative) have their lever attributes drawn from a *known* randomisation distribution, independent of the model. Tag them `assignment = "randomised"`. These are the only rows that identify attribute effects without assumptions. This is the direct analogue of the *"randomized serving events for a random fraction of user visits"* that made Yahoo!'s unbiased offline evaluation possible (Li, Chu, Langford & Wang, https://arxiv.org/abs/1003.5956) — and the reason that paper's replay method works at all is that the logging policy was uniform.

**2. Propensity logging.** For every creative launched, store the probability the policy would have assigned each lever value at that moment. For a TS policy this is estimated by Monte Carlo over the same posterior draws you already made. Without stored propensities, no IPS/DR estimator is available later (§11.1) and the randomised slice is the *only* usable data.

**3. One-lever-at-a-time deltas for the sequential design.** When the loop generates a variant of an existing creative, change exactly one lever and record `parent_creative_id`. A matched pair with one lever difference is worth far more than ten free-form creatives, because the comparison is within-family and the residual `σ²_ad` partially cancels.

**Estimator to use on the randomised slice:** adaptively-weighted AIPW as in Hadad et al. — *"adaptively reweight the terms of an augmented inverse propensity weighting estimator to control the contribution of each term to the estimator's variance"*, which *"eliminates heavy-tailed behavior while maintaining asymptotically correct coverage"*. For the batched setting, BOLS (Zhang et al.) is simpler: run OLS **within each batch**, then combine batch estimates — it is asymptotically normal on multi-arm and contextual bandit data and is robust to non-stationary baselines. Given that we already batch decisions daily/weekly, **BOLS is nearly free to implement and should be the default estimator for any attribute-effect claim we display to a user.**

### 4.6 Embeddings vs. discrete attributes

Tempting: embed the video with a multimodal encoder, regress reward on the embedding. Reasons not to make this the primary representation:
- **Not actionable.** You cannot hand a 768-d vector to a video generator as a brief. Discrete levers are directly executable.
- **Not explainable.** The product's value is partly the sentence "shorter hooks with a spoken question are working for you." Embeddings do not produce that sentence honestly.
- **Data-hungry.** d=768 with n=200 creatives is hopeless without heavy regularisation, at which point you are fitting a low-rank projection you could have designed.

Use embeddings for two narrow, valuable jobs instead: **(a) novelty/dedup** — reject a generated creative whose embedding is within ε of an existing one (prevents the generator from re-making the winner forever and accelerating fatigue), and **(b) a residual feature** — after the discrete model, add the top-k principal components of the embedding as extra covariates and see if they explain residual variance. If they do, that is a signal your attribute vocabulary is missing a dimension; go find it and name it.

---

## 5. Delayed and censored feedback — the section that prevents the most expensive bug

### 5.1 There are four distinct delays and they compound

| # | Delay | Typical magnitude | Source of truth |
|---|---|---|---|
| 1 | **User delay**: click → purchase | minutes to 7/28 days, heavy-tailed | your own pixel/CAPI logs |
| 2 | **Reporting delay**: purchase → visible in Insights | ~15 min normally; **up to ~72 h for Aggregated Event Measurement (AEM) iOS conversions**, which arrive aggregated and delayed (`meta-insights-measurement.md` §4.6) | Meta |
| 3 | **Attribution retro-write**: a click on day D converting on D+k is credited back to **D** | up to 28 days | Meta: *"Insights refresh every 15 minutes and do not change after 28 days of being reported"* — https://developers.facebook.com/docs/marketing-api/insights/best-practices/ |
| 4 | **Censoring**: a conversion after the attribution window is never observed at all | window-dependent | `attribution_setting` per ad set |

Delay #3 is what makes this hard. It means **the row you fetched yesterday is not the row you will fetch next week**, and a naive warehouse that only re-fetches the last 7 days permanently under-reports. From `meta-insights-measurement.md` §5.2: *"Re-fetch a rolling 28-day window on every sync and upsert by (date_start, ad_id, breakdown_key…). A rolling 7-day re-fetch is the commonest under-specification and it costs 5–15 % of reported conversions."*

Delay #4 got worse in 2026. `7d_view` and `28d_view` **return no data since 2026-01-12** but were *not removed from the schema* — request them and you get zeros, not an error (https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/). And since ~March 2026 click-through attribution counts **link clicks only**, with shares/saves/likes/comments moved to engage-through (`1d_ev`), and the video engaged-view threshold cut from 10 s to 5 s (https://www.facebook.com/business/news/click-attribution).

> **Store an `attribution_regime` version stamp on every warehouse row.** Comparing a creative's 2025-11 performance against its 2026-02 performance without one is comparing two different random variables. This is not hypothetical: reported conversions dropped **15–40 %** overnight for view-heavy advertisers on 2026-01-12 [SECONDARY: https://ppc.land/meta-restricts-attribution-windows-and-data-retention-in-ads-insights-api/].

### 5.2 The delayed-feedback model

The canonical formulation is Olivier Chapelle, "Modeling delayed feedback in display advertising", KDD 2014 (verified via Semantic Scholar: https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/2623330.2623634; the author's PDF at http://olivier.chapelle.cc/pub/delayedConv.pdf returns 403 through this proxy).

Its structure, as described in the follow-up literature: it jointly estimates **two models** — a conversion-probability model and a **delay model assuming the time delay follows an exponential distribution** — so that samples *"that are converted after an observation period"* are not simply treated as negative.
Source (describing Chapelle 2014): Yoshikawa & Imai, "A Nonparametric Delayed Feedback Model for Conversion Rate Prediction", https://arxiv.org/abs/1802.00255

The generative story, and the likelihood it implies:

```
For an impression/click i with features x_i:
  C_i ~ Bernoulli(p(x_i))                       # will it EVER convert (within the window)?
  D_i ~ Exponential(λ(x_i))   given C_i = 1     # delay to conversion
  E_i = elapsed time since the click            # observation age

Observed:
  if converted at delay d:      likelihood = p(x) · λ(x) e^{−λ(x) d}
  if not yet converted at E:    likelihood = (1 − p(x)) + p(x) · e^{−λ(x) E}
```

The second line is the whole point: a not-yet-converted observation is a **mixture** of "will never convert" and "will convert later". Fit by EM or joint gradient descent on `(w_p, w_λ)`.
**UNVERIFIED:** the exact likelihood above is reconstructed from the standard description of the model, not read from the original PDF. The *exponential-delay assumption* is verified (Yoshikawa & Imai). Treat the algebra as a faithful reconstruction, not a quotation.

The known weakness, stated by Yoshikawa & Imai: *"in practice, however, there is no guarantee that the delay is generated from the exponential distribution, and the best distribution with which to represent the delay depends on the data."* Real conversion delays are typically **bimodal** — a spike within the first hour and a long tail over days — which an exponential cannot represent.

**The industrial confirmation that this matters:** Ktena et al. compared five loss functions for delayed feedback in continuous CTR training and reported a **55 % gain in revenue per thousand requests (RPMq) against naive log loss** in online experiments, plus a 3 % relative cross-entropy improvement over prior methods on 668 M examples.
Source: Ktena, Tejani, Theis, Myana, Dilipkumar, Huszar, Yoo, Shi, "Addressing Delayed Feedback for Continuous Training with Neural Networks in CTR prediction", RecSys 2019. https://arxiv.org/abs/1907.06558

And the bandit-theoretic version: Vernade, Cappé & Perchet, "Stochastic Bandit Models for Delayed Conversions", UAI 2017 — they treat the case where *"each action may trigger a future reward that will then happen with a stochastic delay"*, distinguish fully-observed from **censored** late conversions, assume conversion probabilities unknown but **delay distributions known**, build UCB/KL-UCB variants, and introduce a *"Poissonization argument"* that *"is particularly valuable when conversion rates are low"*. https://arxiv.org/abs/1706.09186

> **The "delay distributions known" assumption is the one to attack.** Vernade et al. assume you know `F_D`. You actually *can* know it, because you own the pixel/CAPI stream: estimate `F_D` from your own settled cohorts (§5.3). This is the cheapest high-value modelling win in the whole system.

### 5.3 What to actually build: the completion-curve correction

Do not implement Chapelle's joint EM as version one. Implement the **non-parametric completion curve**, which requires no distributional assumption and is a 200-line job.

**Step 1 — estimate the completion curve from settled cohorts.** For each conversion window `W` (e.g. `7d_click`) and each account (or vertical, if the account is small — §7), take cohorts whose `date_start` is older than 28 days (Meta's own freeze horizon, so `C_final` is known) and build

```
F(a) = E[ C_obs(cohort, age = a) / C_final(cohort) ],   a = 0,1,2,…,28 days
```

Estimate it by pooling many `(date_start, ad_set)` cohorts. Because `C_final` is known for settled cohorts, this is a *complete-data* estimate — no censoring machinery needed. Where you want an estimate from *unsettled* cohorts too (a new account with no 28-day history), use the Kaplan–Meier estimator on the click→conversion delay from your own CAPI event stream, treating still-unconverted clicks as right-censored at their current age.

A realistic shape for a DTC e-commerce advertiser on `7d_click` [SECONDARY / illustrative — you must fit your own]:

| age (days) | 0 | 1 | 2 | 3 | 5 | 7 | 14 | 28 |
|---|---|---|---|---|---|---|---|---|
| F(a) | 0.30 | 0.55 | 0.72 | 0.82 | 0.93 | 0.97 | 0.995 | 1.000 |

**Step 2 — correct every read before it enters a decision.**

```
ĉ_final = c_observed / F(age)          # point estimate
```
and, critically, **propagate the variance**. If `c_observed ~ Poisson(θ·s·F(a))`, then

```
θ̂ = c_obs / (s · F(a))            Var(θ̂) = θ / (s · F(a))
```
so a young cohort's estimate has its variance inflated by `1/F(a)`. In the Gamma–Poisson posterior of §3.2 this is exactly one line: use **`s_effective = s · F(age)`** as the exposure.

```python
# The whole delay correction, in the only place it belongs: the posterior update.
def posterior(ad, F):
    k = ad.prior_k
    r = ad.prior_rate
    for row in ad.daily_rows:                    # one row per date_start
        age = (today - row.date_start).days
        k += row.conversions                     # observed so far, un-inflated
        r += row.spend * F(min(age, 28))         # exposure DISCOUNTED by completeness
    return Gamma(shape=k, rate=r)
```

This is the correct Bayesian treatment: you do not inflate the numerator (which would fabricate certainty), you deflate the exposure (which correctly says "we have seen less evidence than the spend suggests"). A brand-new ad with $500 spent and 0 conversions at age 1 has `s_eff = $275`, not $500, and its posterior stays appropriately wide.

**Step 3 — refuse to decide inside the settling window unless the decision is a guardrail.** From `meta-insights-measurement.md` §5.2: *"Never take a kill/scale action on a row whose `date_stop` is within `attribution_click_window_days` of now, unless the decision is a guardrail (spend > cap, `effective_status` in `{DISAPPROVED, WITH_ISSUES}`, zero impressions after N hours)."*

### 5.4 Why naive early stopping systematically kills good ads — with numbers

This is the failure mode to put in the regression test suite.

Two ads in the same ad set, **identical true CPA of $40**. Ad A launched 8 days ago, Ad B launched 2 days ago. Each has spent $800 since launch.

| | Ad A (age 8 d) | Ad B (age 2 d) |
|---|---|---|
| True conversions generated | 20 | 20 |
| Completion `F(age)` | 0.97 | 0.72 |
| **Observed** conversions | 19.4 → 19 | 14.4 → 14 |
| **Observed CPA** | $42.1 | **$57.1** |
| Naive verdict | keep | **kill — 36 % worse** |

The bias is not random; it is **monotone in recency**, so it fires against exactly the ads the generative pipeline just produced. The system's observable behaviour is: it generates creative, kills it two days later, generates more, kills that. Users describe this as "the AI doesn't like anything it makes." It is a join bug, not a model bug.

It gets worse in three ways:
- **Selection compounds it.** The killed young ad never accumulates the data that would have exonerated it. This is unrecoverable — you cannot fix it in post.
- **Budget scaling amplifies it.** A ramping ad set has more spend on recent (under-reported) days than on old days, so its *aggregate* CPA is biased upward exactly when it is scaling. Growth looks like decline.
- **The bias is invisible in Ads Manager**, which shows the same under-reported numbers, so a human "sanity check" confirms the bug.

**Three defences, all cheap:**
1. **Age-matched comparison.** Only compare cohorts of equal age. Concretely: evaluate every ad on its *first N days of life* rather than on a calendar window. `time_increment=1` on the Insights call plus a join on `date_start − ad.created_time` gives you an "age" axis for free.
2. **Completeness-weighted exposure** (§5.3, step 2).
3. **A minimum-age gate.** No kill decision before `age ≥ attribution_click_window_days` (7 for a `7d_click` account) *and* `spend ≥ 1.5 × target_CPA` *and* the ad is not in `learning_stage_info.status == LEARNING`. The first gate is about the data; the second and third about the statistics (§6).

### 5.5 The hybrid date-semantics trap

One more, from `meta-insights-measurement.md` §4.3, because it silently invalidates cohort analysis. Since **2025-06-10**, Meta disregards `use_unified_attribution_setting` and `action_report_time`, and reports as if `action_report_time = mixed`: **on-Meta actions (link clicks, video views) use impression time; off-Meta actions (web purchases) use conversion time.**
Source: https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2025/

Consequence: for a given `date_start`, `spend` is impression-dated and web `purchase` is *conversion*-dated. **A daily ROAS row is therefore not a cohort.** It matches Ads Manager (good — no support tickets) but it is not "revenue caused by that day's spend."

Two options, pick deliberately:
- **Accept the hybrid** for all Meta-facing reporting and for the bandit's exposure-weighted posterior (the completion correction partially absorbs it).
- **Reconstruct true cohorts from your own CAPI/pixel stream**, joining `fbclid`/`fbc` → click timestamp → conversion timestamp, and use *that* for the marginal-return curves of §8. This is the only way to get honest `spend(D) → value caused by D` economics, and it is a strong argument for making CAPI a hard onboarding requirement rather than an optional integration.

---

## 6. Decision rules a practitioner can defend at small n

### 6.1 Why fixed-horizon p-values are the wrong tool here

Four independent reasons, any one of which is disqualifying:

1. **There is no fixed horizon.** The loop looks at the data every day and can act every day. A p-value's validity is defined *conditional on a pre-committed sample size*; continuous monitoring inflates Type-I error without bound. This is precisely the problem "always valid inference" was invented for (Johari, Pekelis & Walsh, https://arxiv.org/abs/1512.04922).
2. **The null hypothesis is uninteresting.** "This creative has exactly the same CPA as the incumbent" is false a priori and nobody cares. The decision-relevant question is "is it worse by enough to matter, and what does it cost me to be wrong?"
3. **The costs are asymmetric and known.** Keeping a 20 %-worse ad for another week costs a computable number of dollars. A false-positive rate of 5 % is not a business quantity. Use a loss function, not an error rate.
4. **We can't afford the sample size** (§6.4). A rule that says "insufficient data" every time is not a decision rule; it is an abdication, and the money gets spent anyway while you wait.

### 6.2 The rule to implement: expected loss against a threshold of caring

The clean, defensible formulation (Chris Stucchio's exposition of the VWO/Bayesian rule):
1. establish a **threshold of caring** — *"if A and B differ by less than this threshold, you don't care which one you choose"*;
2. put a prior on each variant's rate;
3. stop when the **expected loss** of the decision falls below the threshold.

For Beta posteriors the expected loss of choosing A when B might be better has a closed form:

```
E[loss | choose A] = ∫₀¹ ∫_y¹ (x − y) · Beta(x; a,b) · Beta(y; c,d) dx dy

              = [B(a+1,b)/B(a,b)] · h(a+1,b,c,d) − [B(c+1,d)/B(c,d)] · h(a,b,c+1,d)

where h(a,b,c,d) = P(X > Y) = 1 − Σ_{j=0}^{c−1} B(a+j, b+d) / ((d+j)·B(1+j,d)·B(a,b))
```
Source: https://www.chrisstucchio.com/blog/2014/bayesian_ab_decision_rule.html

For the Gamma–Poisson / CPA formulation there is no equally tidy closed form; **just Monte-Carlo it** — 20,000 joint draws from the two posteriors costs microseconds and is exactly as defensible.

**The three quantities to compute and store for every candidate-vs-incumbent pair:**

```python
draws_new = gamma_rvs(k_new, r_new, N)      # conversions per dollar
draws_inc = gamma_rvs(k_inc, r_inc, N)
cpa_new, cpa_inc = 1/draws_new, 1/draws_inc

P_better        = mean(cpa_new < cpa_inc)                    # "chance it's better"
P_worse_by_X    = mean(cpa_new > cpa_inc * (1 + X))          # X = threshold of caring, e.g. 0.20
E_loss_keep     = mean(maximum(cpa_new - cpa_inc, 0))        # $ per conversion lost by keeping it
E_loss_kill     = mean(maximum(cpa_inc - cpa_new, 0))        # $ per conversion lost by killing it
```

`P_worse_by_X` is the number the assignment asks for — "probability this ad is worse than incumbent by more than X %" — and it is also the number to show a user, because it is the only one that survives translation into English.

**The decision rule:**

```
KILL   if  P_worse_by_X ≥ κ_kill        (default κ_kill = 0.80, X = 0.20)
SCALE  if  P_better ≥ κ_scale           (default κ_scale = 0.85) AND gates pass
HOLD   otherwise
```

with an explicit **region of practical equivalence**: if `P(|CPA_new/CPA_inc − 1| < X) ≥ 0.9`, declare *equivalent* and stop spending decision-budget on the comparison. Declaring equivalence is a real outcome and most systems never implement it, so they re-litigate the same comparison forever.

**Calibrate κ from the actual costs, not from convention.** Keeping an ad that is `δ` worse for another `T` days at daily budget `b` costs `b·T·δ/(1+δ)`. Killing an ad that was actually `δ` better forfeits the same, *plus* the sunk learning-phase cost of replacing it (§2.6). Because the replacement cost is real and the ad slot is not free, **the kill threshold should be strictly stricter than the keep threshold** — the system should be biased toward keeping, which is the opposite of most naive rule engines.

### 6.3 Anytime-valid alternatives when you need a frequentist artefact

Sometimes you need something to show a sceptical media buyer or to put in a case study. Then use an *always-valid* construction rather than a t-test:

- **mSPRT / always-valid p-values** (Johari, Pekelis & Walsh): p-values and confidence intervals that *"remain statistically valid regardless of when a researcher decides to stop"*, giving *"valid statistical inference whenever they make their decision"*. Deployed on *"a large scale commercial A/B testing platform to analyze hundreds of thousands of experiments"*. https://arxiv.org/abs/1512.04922
- **Confidence sequences**: *"a sequence of confidence intervals that is uniformly valid over an unbounded time horizon"*, nonparametric and nonasymptotic, connecting the Cramér–Chernoff method, the law of the iterated logarithm and the SPRT. Howard, Ramdas, McAuliffe & Sekhon, *Annals of Statistics* 49(2):1055–1080, 2021. https://arxiv.org/abs/1810.08240

Practical note: for Poisson counts, a Gamma-mixture mSPRT is straightforward and gives you an e-value you can multiply across days. The price of anytime-validity is roughly a **√(log log n)** widening — perhaps 20–40 % more data than a fixed-horizon test at our sample sizes. That is the honest cost of being allowed to look every day.

### 6.4 The sample-size table that determines the whole product

For rare events, the log rate ratio has `Var(log RR) ≈ 1/E₁ + 1/E₂ = 2/E` where `E` is conversions **per arm** with equal exposure. So the minimum detectable relative effect is `exp(z · sqrt(2/E))`.

| Conversions **per arm** | MDE, 80 % power, α=0.05 two-sided (z=2.802) | One-sided Bayesian rule at P≥0.90 (z=1.282) | Spend/arm at $40 CPA |
|---|---|---|---|
| 25 | +121 % | +44 % | $1,000 |
| **50** (Meta's learning-phase threshold) | **+75 %** | +29 % | $2,000 |
| 100 | +49 % | +20 % | $4,000 |
| 200 | +32 % | +14 % | $8,000 |
| 400 | +22 % | +9.5 % | $16,000 |
| **470** | **+20 %** | +9 % | $18,800 |
| 1,000 | +13 % | +6 % | $40,000 |
| 2,000 | +9 % | +4 % | $80,000 |

Read the two right-hand columns together. **They are the product strategy.**

- A rigorous two-sided test for a 20 % CPA difference needs ~470 conversions per arm — **$37,600 for a two-arm test at a $40 CPA.** For most advertisers this is a year's budget. Any roadmap that promises statistically significant creative testing to SMBs is promising something arithmetically impossible.
- The same data supports a **one-sided Bayesian kill rule at 90 % posterior confidence for a 20 % difference at 100 conversions per arm** — $4,000/arm. That is achievable in a week or two for a mid-market advertiser.
- **Meta's own learning-phase threshold of ~50 events is 10× too small for a defensible two-sided test and roughly right for a one-sided kill rule at a 29 % effect.** This is not a coincidence: 50 events is the amount of data *Meta's* optimiser needs to stabilise, not the amount *your* comparison needs.

> **The honest statement to put in the product:** "We stop ads that are probably much worse, and we scale ads that are probably better. We cannot tell you which of two similar ads is better, and neither can anyone else at your budget." Lewis & Rao's *"median confidence interval on return on investment is over 100 percentage points wide"* is the citation that backs this up (https://doi.org/10.1093/qje/qjv023).

### 6.5 The gates — necessary conditions before any decision runs

Every one of these has cost somebody a day of debugging. All must pass:

```python
DECISION_GATES = dict(
    min_age_days            = attribution_click_window_days,   # 7 for a 7d_click account (§5.4)
    min_spend               = 1.5 * target_cpa,                # else CPA is undefined-ish
    min_impressions         = 1000,                            # also Meta's floor for ranking diagnostics
    not_learning            = "learning_stage_info.status != 'LEARNING'",
    settled_rows_only       = "date_stop <= today - attribution_window",
    same_attribution_setting= True,   # never aggregate rows with differing `attribution_setting`
    completion_corrected    = True,   # §5.3
    no_significant_edit_within = 3,   # days since last_sig_edit_ts
    delivery_healthy        = "effective_status == 'ACTIVE' and impressions_last_24h > 0",
)
```

Notes on the non-obvious ones:
- **`same_attribution_setting`.** Rows in one Insights response can be attributed differently, because attribution is now taken from each *ad set's* own setting. Always request `attribution_setting` as a field and refuse to aggregate across differing values unless you explicitly requested a specific `action_attribution_windows` key (`meta-insights-measurement.md` §4.5).
- **`min_impressions = 1000`.** Below this the `quality_ranking` / `engagement_rate_ranking` / `conversion_rate_ranking` fields are not populated, and neither is anything else stable.
- **Many `date_preset` values include today's partial data.** A CPA rule evaluated at 09:00 sees a morning of spend against almost no attributed conversions (`meta-optimization-controls.md` §11 gotcha 6). Always add a spend floor and an age floor to any cost-shaped rule.

### 6.6 A worked kill decision, end to end

```
Incumbent ad  IN: spend $6,400, conversions 158, ages 3–24 days, F-weighted exposure $6,190
Candidate ad  CA: spend $1,900, conversions  34, ages 1–9  days, F-weighted exposure $1,655

Prior: target CPA $40 ⇒ k₀ = 1, rate₀ = 40   (worth one conversion's spend)

θ_IN | data ~ Gamma(1 + 158, 40 + 6190) = Gamma(159, 6230)   ⇒ CPA median ≈ $39.2
θ_CA | data ~ Gamma(1 +  34, 40 + 1655) = Gamma( 35, 1695)   ⇒ CPA median ≈ $48.4

Monte Carlo, 50k draws:
  P(CPA_CA > CPA_IN)                = 0.87
  P(CPA_CA > 1.20 × CPA_IN)         = 0.56     ← well below κ_kill = 0.80
  E[loss | keep CA]                 = $9.9 per conversion
  E[loss | kill CA]                 = $0.7 per conversion

Verdict: HOLD (not KILL). It is probably worse, but nowhere near confidently worse *by enough*.
Action: do not scale it, do not kill it, let it run to the next weekly window.
At CA's current burn (~$210/day) it reaches ~64 conversions in 7 more days; re-evaluate then.

Sanity check on the arithmetic: sd(log θ) ≈ 1/√k, so 1/√159 = 0.079 for IN and 1/√35 = 0.169 for CA;
the log-CPA gap is log(48.4/39.2) = 0.212 against a combined sd of √(0.079² + 0.169²) = 0.187,
i.e. z ≈ 1.13 ⇒ P ≈ 0.87 one-sided. To clear a 90 % one-sided bar (z ≥ 1.282) with these arm sizes you
would need an observed gap of at least exp(1.282 × 0.187) − 1 = **+27 %**. The observed gap is +24 %.
**34 conversions is simply not enough**, and the §6.4 table said so before you ran the query.
```

That "probably worse but not confidently worse by enough" state is where most creatives live most of the time, and a system that cannot represent it will thrash. **HOLD is the modal decision and must be a first-class outcome, not a fall-through.**

---

## 7. Hierarchical models and partial pooling — how a low-volume advertiser borrows strength

### 7.1 The hierarchy

```
vertical            (e.g. DTC supplements, local home services, B2B SaaS)
  └─ account        (one advertiser's ad account)
       └─ campaign  (objective + budget)
            └─ ad set  (audience + optimisation goal)   ← Meta's learning unit
                 └─ ad (one generated video)             ← our decision unit
                      └─ day × placement × age cohort    ← observation
```

Two orthogonal pooling axes, and they answer different questions:

| Axis | Pools across | Answers |
|---|---|---|
| **Vertical pooling of attribute coefficients** | accounts, verticals | "do problem-agitate hooks work?" → transfers to a brand-new advertiser on day 1 |
| **Nested pooling of level effects** | ads within ad set, ad sets within account | "is this ad better than its siblings?" → stabilises small-n comparisons |

The first axis is the platform's moat: an advertiser joining on Monday inherits attribute priors learned from every other advertiser in their vertical. The second is what stops a 3-conversion ad from claiming a $13 CPA.

### 7.2 Empirical Bayes shrinkage — the 50-line version that you should ship first

For a rate `θ_i` observed as `c_i` conversions on exposure `s_i` dollars, put a Gamma prior fitted to the population by method of moments:

```
population mean       μ̂ = Σ c_i / Σ s_i
population variance   estimate Var(θ) from the between-ad spread net of Poisson noise:
                      Var(θ̂) ≈ (1/(m−1)) Σ (c_i/s_i − μ̂)²  −  μ̂ · (1/m) Σ 1/s_i
prior shape           k₀ = μ̂² / Var(θ)          prior rate  r₀ = μ̂ / Var(θ)
shrunk estimate       θ̃_i = (k₀ + c_i) / (r₀ + s_i)
                            = w_i · (c_i/s_i)  +  (1 − w_i) · μ̂ ,    w_i = s_i / (s_i + r₀)
```

The Beta–Binomial analogue is the familiar one: `θ̃ = (α₀ + c)/(α₀ + β₀ + n)`, with `α₀+β₀ = M` acting as "pseudo-trials" and `M = μ(1−μ)/Var − 1` from moment matching.

Three properties worth internalising:
- **`r₀` has units of dollars.** It is literally "how many dollars of evidence the prior is worth." That makes it explainable and tunable: `r₀ = 3 × target_CPA` means "we trust an ad's own numbers once it has spent three conversions' worth."
- **Shrinkage is automatic ranking regularisation.** The top of a raw CPA leaderboard is always the ads with the fewest conversions. After shrinkage it is the ads with genuinely good, well-measured performance. **Never display an unshrunk leaderboard to a user or to an LLM** (§10.3) — both will over-interpret it.
- **Subtracting the Poisson term matters.** If you skip `− μ̂ · mean(1/s_i)` you attribute pure sampling noise to true between-ad variance, `Var(θ)` is inflated, `r₀` collapses, and shrinkage does nothing. This is the most common empirical-Bayes implementation bug.

### 7.3 The full hierarchical model, when you outgrow moments

```
log θ[ad a in adset s, account j, vertical v]
     = β_v[vertical]                       # vertical baseline (log conversions per dollar)
     + u_j                                 # account offset      u_j ~ N(0, τ²_acct)
     + z_s                                 # ad set offset       z_s ~ N(0, τ²_adset)
     + x_aᵀ (γ + δ_v)                      # attribute effects: global γ + vertical deviation δ_v
     + ε_a                                 # residual ad effect  ε_a ~ N(0, σ²_ad)
c_a ~ Poisson(θ_a · s_a_effective)         # s_effective is completeness-weighted (§5.3)
```

Notes that are easy to get wrong:

- **Pool on the log scale, never on raw CPA or raw CVR.** A local plumber converts at 8 % and a DTC apparel brand at 1.2 %; pooling raw rates is meaningless. Pooling *log-ratios* (attribute effects) is the whole point — the claim "captions lift conversions ~9 %" is portable; "captions add 0.4 pp" is not. This is also the guard against Simpson's paradox: attribute mix differs by vertical, so a raw pooled comparison of `captions=true` vs `false` across verticals can invert the within-vertical sign.
- **`δ_v` (vertical-specific attribute deviations) is what makes the model useful rather than bland.** With `δ_v ~ N(0, τ²_attr)` you get automatic partial pooling: a vertical with lots of data gets its own attribute effects; a new vertical inherits the global ones.
- **`σ²_ad` must be estimated, not assumed.** It is the honest answer to "how much of creative performance do attributes explain?" Report it. If `σ²_ad` swamps `Var(x^T γ)`, the correct product statement is "creative execution matters more than creative strategy for you," which is a real and defensible finding.

**Implementation.** Fit nightly in NumPyro/Stan on the fleet-wide table (this is a batch job over thousands of rows, not millions — it runs in minutes), then **push the fitted `γ`, `δ_v`, `τ²`, `σ²_ad` into the online service as priors**. The online loop does conjugate Gamma–Poisson updates per ad (§3.2) and never runs MCMC in the request path. This two-speed design — slow hierarchical refit, fast conjugate serving — is the standard and correct architecture.

### 7.4 What partial pooling buys, quantitatively

For an advertiser with 40 conversions/month total, a per-ad independent estimate has an sd on log CPA of `1/√c ≈ 1/√8 = 0.35` for an ad with 8 conversions — a ±42 % interval. With `r₀` equal to three conversions of prior evidence and a vertical prior mean, the posterior sd drops to `1/√(8+3) = 0.30` and, more importantly, the *point estimate* stops being dominated by whichever ad got lucky. The gain is small in variance terms and large in **ranking stability**, which is what the decision rule consumes.

The bigger win is the attribute prior at cold start: a new creative in a well-populated vertical starts with an effective prior worth tens of conversions of information *about its attributes*, versus nothing.

> **Where pooling bites you.** If one account is 90 % of the fleet's spend, `γ` is that account's preferences wearing a lab coat. Weight the hierarchical fit by *account*, not by row — or explicitly cap each account's contribution to the likelihood. Otherwise your "cross-vertical creative science" is one advertiser's taste, and it will transfer terribly.

---

## 8. Budget allocation as a constrained portfolio problem

### 8.1 The correct optimality condition: equalise **marginal** CPA, not average CPA

Maximise total conversions `Σ_i V_i(b_i)` subject to `Σ_i b_i = B, b_i ≥ 0`. The KKT conditions give

```
V_i'(b_i) = λ    for every i with b_i > 0
V_i'(b_i) ≤ λ    for every i with b_i = 0
```

`V_i'` is marginal conversions per dollar, so `1/V_i'` is **marginal CPA**. The optimum equalises marginal CPA across everything you fund, and `λ` is the shadow price — *the marginal CPA of the whole portfolio*, which is also exactly the number to compare against the advertiser's target CPA to decide whether the **total** budget should grow or shrink.

Google's Meridian implements exactly this for MMM: its flexible-budget scenario works *"toward equalizing marginal ROI across channels"*, targeting a marginal ROI *"where the marginal ROI of each media channel hits the target marginal ROI"*.
Source: https://developers.google.com/meridian/docs/user-guide/budget-optimization-scenarios

**The non-obvious consequence, and it is the whole point of this section:**

```
Ad set A: average CPA $30, steeply saturating  → marginal CPA at current budget = $80
Ad set B: average CPA $45, nearly linear       → marginal CPA at current budget = $50
```
The correct action is to move money **from A to B** — from the "better" ad set to the "worse" one. Every rule engine that ranks on average CPA does the opposite. This single confusion is, in my judgement, the most common defect in automated budget tools, and it is invisible because the resulting portfolio CPA degrades slowly.

### 8.2 Response curves: what functional form, and how to estimate it honestly

Use the same shapes the MMM literature has converged on. Meridian's exact forms:

```
Adstock:   Adstock({q_{t−s}}_{s=0..L}, α) =  Σ_{s=0..L} w(s;α) q_{t−s}  /  Σ_{s=0..L} w(s;α)
           with α ∈ [0,1] the decay parameter and w(s;α) the decay weighting

Hill:      Hill(q, ec, slope) = (1 + (q/ec)^{−slope})^{−1}
           with ec > 0 the half-saturation point and slope > 0 the shape parameter
```
Source: https://developers.google.com/meridian/docs/basics/model-spec

For a single ad set's daily conversions the practical parameterisation is

```
V(b) = K · (1 + (b/ec)^{−slope})^{−1}        # K = ceiling conversions/day
V'(b) = K · slope · (b/ec)^{−slope} / (b · (1 + (b/ec)^{−slope})²)
```

**The estimation problem is endogeneity, and it is severe.** Observational `(budget, CPA)` pairs are useless because budget was *set in response to* performance: you raised budget on the days it was working. Regressing CPA on budget then recovers your own past decision rule, not the response curve. This is precisely the failure Gordon, Zettelmeyer, Bhargava & Chapsky documented at Facebook: *"Observational methods often fail to accurately recover the treatment effects generated from randomized advertising experiments on Facebook."*
Source: *Marketing Science* 2019, https://doi.org/10.1287/mksc.2018.1135

**Therefore: budget perturbations must be *designed*, not observed.** Concretely:
- On a fixed schedule (e.g. every 14 days), apply a **randomised ±15 % budget step** to a randomly chosen subset of ad sets, holding others fixed. Keep the step inside the "may restart learning" band and always well below the $100→$1000 example Meta gives as clearly significant.
- Record `last_sig_edit_ts` before and after; discard any perturbation that triggered a learning reset (that arm is contaminated).
- Fit the Hill curve on the *perturbation* data only, pooled hierarchically across ad sets within account and across accounts within vertical (§7). A single ad set will never identify `slope`; the fleet will.
- Use **`budget_schedules` (high-demand periods) for planned upward steps** rather than editing `daily_budget`: `POST /{ADSET_ID}/budget_schedules` with `time_start`, `time_end`, `budget_value`, `budget_value_type ∈ {ABSOLUTE, MULTIPLIER}`. It is declared ahead of time and is not a mid-flight budget edit. Limits: max 50 HDPs per campaign or ad set, minimum 3 hours each, total ≤ 8× the daily budget, **daily budgets only** (https://www.facebook.com/business/help/633318028866693).

**UNVERIFIED:** whether a `budget_schedules` HDP counts as a "significant edit" for the learning phase. It does not appear on Meta's significant-edit list, which is suggestive but not dispositive. Measure it with `last_sig_edit_ts` before adopting it as the primary scaling mechanism.

### 8.3 The explore/exploit split of the budget

Do not implement exploration as ε-greedy over creatives (§3.7 — a randomly chosen bad creative burns real money). Implement it as a **budget line item**:

```
B_total = B_exploit + B_explore
B_explore = clamp(ρ · B_total,  lower = n_new_creatives × min_test_spend,  upper = 0.35 · B_total)
```

with `ρ` defaulting to **0.20** and

```
min_test_spend = n_conv_required × target_CPA
n_conv_required = 2 · (z_decision / ln(1 + X))²        # X = threshold of caring, z from §6.4
                = 2 · (1.282 / ln 1.20)² ≈ 99          # one-sided Bayesian rule at P ≥ 0.90, X = 20 %
```

i.e. **~100 conversions per new creative, or $4,000 at a $40 CPA**, to give it a fair read at a 20 % threshold of caring. Lower `X` or raise `z_decision` and the cost rises quadratically — halving the detectable effect quadruples the spend.

The floor is the important half. To give a new creative a fair read you need it to reach the §6.4 decision threshold within the test window. At a $40 CPA and a one-sided-90 % rule at 100 conversions, that is $4,000 — which means an account under ~$20k/week cannot test two creatives properly per week no matter how you slice it. This gives the honest capability tiering:

| Weekly budget | Creatives testable/week at a defensible confidence | Structure (§2.4) | What the product should promise |
|---|---|---|---|
| < $2,000 | **0** | S1, single consolidated ad set | "we refresh creative on a schedule and stop obvious losers" — no testing claims |
| $2,000–$8,000 | ~1, at a ~30–50 % MDE | S1 with sequential batches | "we detect large differences" |
| $8,000–$30,000 | 2–3, at a ~20–30 % MDE | S1 or S2 | "we can rank your creative concepts" |
| > $30,000 | 4+, at a ~15–20 % MDE | S2/S3, real cells | "we run controlled creative experiments" |

**Do not let exploration budget go to zero when things are going well.** The fatigue dynamics of §9 guarantee that today's winner decays; an account with no pipeline of tested challengers experiences a CPA cliff with nothing to switch to. Encode a hard floor: `B_explore ≥ 0.10 · B_total` whenever the portfolio has fewer than 3 ads with `P_better ≥ 0.5` against the incumbent.

### 8.4 Pacing arithmetic you must model, or you will overspend

From `meta-optimization-controls.md` §2.1, all verbatim from https://www.facebook.com/business/help/190490051321426:
- Meta *"may spend up to **75 % over your daily budget**"* on a given day.
- *"For every week ending Saturday at midnight, spending won't be more than **7 times your daily budget**."*
- With ad set budget sharing on, *"up to 20 % of your flexible daily budget"* may be shared with other ad sets — *"up to 210 % of your daily budget"*.
- On a mid-day change, the daily cap remains **175 % of the highest budget amount set that day**.

> **The irreversibility gotcha, restated because it is a money bug:** raising an ad set from $100 → $400 at 10:00 and rolling it back at 11:00 can still result in up to **$700** of spend that day, because the ceiling anchors to the *highest* budget set that day. Treat every upward budget write as irreversible for the calendar day. Implementation: a per-object daily monotone high-water mark in your own store, and a hard refusal to write a budget above `high_water × 1.0` more than once per day.

Also: the weekly 7× ceiling resets **Saturday midnight in the ad account time zone**, not on a rolling window. A Friday increase has one day of runway.

### 8.5 The allocation algorithm, with every clamp

```python
def daily_budget_decision(account, campaigns, now):
    # 0. HARD PRECONDITIONS -------------------------------------------------
    assert now.hour < 12, "Meta: change bid/budget '2-3 times a day and only the early part of the day'"
    if account.circuit_breaker_open: return []           # §12
    if account.spend_mtd >= account.spend_cap_mtd: return [pause_all(account)]

    actions = []
    # 1. PORTFOLIO-LEVEL: should total spend grow at all? --------------------
    lam = portfolio_marginal_cpa(campaigns)              # shadow price λ from §8.1
    if   lam < 0.85 * account.target_cpa: total_delta = +0.15   # headroom -> scale up
    elif lam > 1.15 * account.target_cpa: total_delta = -0.15   # over target -> pull back
    else:                                  total_delta =  0.00

    # 2. PER-CAMPAIGN: equalise marginal CPA --------------------------------
    for c in campaigns:
        if c.learning_stage == "LEARNING":  continue      # never edit during learning
        if c.days_since_sig_edit < 3:       continue
        target = solve_equal_marginal(c, lam, total_delta)

        # 3. CLAMPS ---------------------------------------------------------
        target = clamp(target,
                       lo = max(account.min_daily_budget[c.currency],   # /minimum_budgets, per currency
                                0.80 * c.daily_budget),                 # max -20 %/day
                       hi = min(1.20 * c.daily_budget,                  # max +20 %/day
                                account.max_daily_budget_per_campaign))
        target = min(target, c.daily_high_water_today)                  # §8.4 irreversibility
        if abs(target - c.daily_budget) / c.daily_budget < 0.05:
            continue                                                    # don't burn a write on noise
        if c.budget_writes_today >= 2:      continue                    # Meta: 2-3/day max
        actions.append(SetBudget(c.id, round_to_minor_units(target)))
    return actions
```

Details that matter:
- **`min_daily_budget` is currency-dependent and must be fetched**, not hardcoded: `GET /v26.0/act_{id}/minimum_budgets` returns `min_daily_budget_high_freq`, `min_daily_budget_imp`, `min_daily_budget_low_freq`, `min_daily_budget_video_views` in the currency's minor units (https://developers.facebook.com/docs/marketing-api/reference/minimum-budget/). Cache per account at onboarding.
- **±20 % per day is a convention, not a documented threshold.** Meta publishes no percentage. It is chosen because it is far from the $100→$1000 example Meta cites as clearly significant, and because a ±20 % ladder still reaches 10× in `ln(10)/ln(1.2) ≈ 13` days — fast enough for any real scaling need.
- **Never write ad-set `daily_spend_cap` under CBO.** It constrains the campaign-level pacer and is on the "may restart learning" list.
- **Round to minor units and respect zero-decimal currencies** (JPY, KRW) — see `meta-api-foundations.md`.

### 8.6 Scaling: the ladder, not the leap

A 13-day ×10 ladder at 20 %/day is nearly always better than one large jump, because:
- each step is below the "likely significant edit" threshold, so learning is preserved;
- the marginal-CPA curve is re-estimated at every rung, so you stop at the right place instead of overshooting into the saturated region;
- if the auction turns, you unwind from a lower rung.

Exception: **planned demand** (a launch, a sale, Black Friday). Use `budget_schedules` HDPs, declared in advance, up to 8× the daily budget. That is the mechanism Meta designed for a leap, and it does not look like a mid-flight edit.

---

## 9. Non-stationarity: fatigue, seasonality and auction drift

### 9.1 Four distinct sources, four distinct treatments

| Source | Timescale | Shape | Treatment |
|---|---|---|---|
| **Day-of-week / hour-of-day** | 1 week | periodic | deseasonalise before comparing; never compare a Tue-heavy window to a Sun-heavy one |
| **Creative fatigue** | 1–4 weeks | monotone decay in the ad's *own* cumulative exposure | decay model on frequency (§9.3) |
| **Auction/competitive drift** | weeks–months | slow level shift affecting *all* ads in the account | account-level index; do not attribute it to creative |
| **Regime breaks** (attribution change, tracking loss, policy action, seasonal onset) | instantaneous | step | change-point detection + posterior reset (§9.4) |

The single most valuable structural habit: **always keep one stable "control" creative running.** It absorbs the account-level index. Then every creative comparison is a *ratio to the control in the same window*, which cancels seasonality and auction drift exactly. This costs a few percent of budget and removes an entire class of false conclusions. It is also the only cheap way to detect an account-wide regime break as distinct from a creative problem.

### 9.2 Discounted and sliding-window posteriors

Garivier & Moulines, "On Upper-Confidence Bound Policies for Non-Stationary Bandit Problems" (2008) analyse discounted-UCB and sliding-window-UCB for the abruptly-changing case, where *"the distributions of rewards remain constant over epochs and change at unknown time instants"*, and show both *"match the lower-bound up to a logarithmic factor"*. https://arxiv.org/abs/0805.3415

The Bayesian analogue for our Gamma–Poisson posterior is one line:

```
k_t = γ · k_{t−1} + c_t
r_t = γ · r_{t−1} + s_t_effective
```

with `γ` chosen from the memory you want: the effective window is `1/(1−γ)` updates. Updating daily:

| desired memory | γ |
|---|---|
| 7 days | 0.857 |
| 14 days | 0.929 |
| 21 days | 0.952 |
| 28 days | 0.964 |

**Default: γ = 0.95 (≈21 days) for creative-level posteriors, γ = 0.98 (≈50 days) for attribute coefficients.** Attributes are more stable than individual creatives; discounting them as fast as creatives throws away the transfer learning that is the whole point of §4.

> **The interaction with delay is a real trap.** Discounting up-weights recent data, and recent data is *systematically under-reported* (§5). Applying a discount to raw counts double-penalises new evidence and makes the system chronically pessimistic about the present. **Order of operations is mandatory: completeness-correct the exposure first (`s_effective = s·F(age)`), then discount.** Discounting a completeness-corrected exposure is correct; discounting raw spend is not.

A sliding window (keep the last W days of rows, recompute from scratch) is easier to reason about, easier to debug, and — at our data volumes — free. Prefer it for anything a human will inspect; keep exponential discounting for the online attribute model where you do not want to store history.

### 9.3 Creative fatigue as a decaying reward, not a threshold

Meta publishes two fatigue states with actual numbers, which is unusual and useful:

| Delivery status | Verbatim definition |
|---|---|
| **Creative limited** | *"cost per result is more than ads you ran in the past but less than twice"* |
| **Creative fatigue** | *"cost per result is more than or equal to twice as much as ads"* previously performed |
Source: https://www.facebook.com/business/help/1346816142327858

These surface programmatically as the `CREATIVE_LIMITED` and `CREATIVE_FATIGUE` recommendation types on `GET /v26.0/act_{id}/recommendations`, and `CREATIVE_FATIGUE` is one of the 14 types applyable via `POST` with a `recommendation_signature` (`meta-optimization-controls.md` §10). **This is Meta telling you, with its own threshold, exactly which ads to replace — a free, high-precision trigger for the generation pipeline.** Fetch it on every sync; signatures expire.

But a 2× threshold is a *very* late signal. Model the decay so you can act earlier:

```
logit p_a(t)  =  μ_a  −  λ_a · Φ_a(t)          # Φ_a(t) = cumulative frequency of ad a to date
λ_a ~ Normal(λ̄_vertical, τ²)                   # partial pooling: fatigue rate is a per-vertical property
```

Fit `λ̄` per vertical from the fleet; per-ad `λ_a` shrinks to it. Then the kill decision becomes economic rather than threshold-based:

```
expected_remaining_value(a) = ∫ over next H days of  budget · (θ_a(t) · value − 1)  dt
kill a  ⟺  expected_remaining_value(a) < expected_value(best available challenger) − switching_cost
```
where `switching_cost` is the learning-phase reset cost of §2.6. **Fatigue then never needs a hardcoded frequency threshold**, which is important because Meta publishes none.

Practitioner priors, useful only as starting points (all **[SECONDARY]**, from `meta-optimization-controls.md` §8.5): cross-industry median frequency ≈ 3.0; prospecting 7-day frequency < 2; retargeting 3–8/week tolerable; reported creative lifespan ~8–14 days at meaningful spend; and the diagnostic fingerprint — **CTR falling while frequency rises with conversion rate roughly flat**, i.e. repeated exposure hits click probability before it hits conversion probability. That last one is a genuinely useful discriminator: if CVR is falling too, it is probably not fatigue, it is an audience or offer problem.

Measurement note: mean `frequency` hides the tail. The `frequency_value` breakdown gives the distribution, but **it works exclusively with `reach`** — you cannot get spend or conversions bucketed by frequency in the same call (https://developers.facebook.com/docs/marketing-api/insights/breakdowns/).

### 9.4 Change-point detection

Liu, Lee & Shroff's CD-UCB framework (CUSUM-UCB and PHT-UCB) detects changepoints and resets the bandit's indices, achieving *"the best known regret upper bound under mild assumptions"* on both synthetic Bernoulli rewards and real Yahoo! CTR data. AAAI 2018, https://arxiv.org/abs/1711.03539

What to actually run, in order of value:

1. **Exogenous change-points you already know about.** Attribution regime changes (2026-01-12, March 2026), pixel/CAPI outages, product price changes, a competitor's launch you were told about. Maintain a `regime_events` table and **hard-reset posteriors at known breaks** rather than hoping a detector finds them. A known break beats a detected one every time.
2. **Account-level CUSUM on the control creative's log CPA.** Because the control absorbs account-wide drift (§9.1), a CUSUM alarm on the *control* means "the world changed", while an alarm on a single creative means "that creative changed". This decomposition is worth more than the detector's sophistication.
3. **Data-integrity CUSUM.** Conversions per click dropping sharply is far more often a broken pixel than a creative problem. Cross-check against your own CAPI event count before letting the optimiser react. Meta exposes `deduping_ratio` / `deduping_1st_source_ratio` etc. in Insights as the in-platform view of pixel↔CAPI dedup (`meta-insights-measurement.md` §2.2) — **UNVERIFIED** sub-shapes, discover empirically.

**Never let a change-point detector fire a kill.** Its correct output is `HOLD + re-explore`: widen posteriors (multiply `k` and `r` by a factor < 1, preserving the mean but inflating variance — exactly the §3.4 reshaping trick run in reverse with α > 1), and route the anomaly to the diagnostics path. A detector that pauses ads will eventually pause an entire account on a reporting glitch.

---

## 10. The LLM-in-the-loop layer

### 10.1 Role separation: the LLM proposes, the statistics disposes

The failure mode this section exists to prevent: an LLM reads a performance table, says "videos with a question hook are performing 34 % better, so let's make more of those", and the system dutifully floods the account with question hooks — where the 34 % came from four conversions on one ad that Meta happened to favour for two days.

Hard boundaries, enforced in code, not in the prompt:

| The LLM MAY | The LLM MAY NOT |
|---|---|
| propose creative hypotheses and write generation briefs | set or change any budget |
| name which lever to vary next | decide which ad wins or gets killed |
| write natural-language explanations of a decision the stats layer already made | compute or assert a statistic |
| tag/normalise creative attributes at generation time | assert causality from observational data |
| summarise into memory records with attached evidence IDs | write a memory record without an evidence ID |

Implementation: the LLM's only *write* path is `POST /hypotheses` and `POST /creative_briefs`, both of which land in a queue that the statistics layer gates. It has **no credential** for the Meta API. This is worth stating in the architecture doc explicitly, because "give the agent the API and let it decide" is the default design everyone reaches for and it is how accounts get destroyed.

### 10.2 The hypothesis loop

```
  ┌────────────────────────────────────────────────────────────────────┐
  │ 1. EVIDENCE PACK   (deterministic code, no LLM)                    │
  │    shrunk posteriors, attribute coefficients with CIs, fatigue     │
  │    curves, funnel ratios, retention curves, the control index      │
  └───────────────┬────────────────────────────────────────────────────┘
                  ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │ 2. HYPOTHESIS GENERATION  (LLM)  → typed Hypothesis objects        │
  │    each must cite evidence_ids and name exactly one lever delta    │
  └───────────────┬────────────────────────────────────────────────────┘
                  ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │ 3. ADMISSION CONTROL (code): dedupe vs memory, power check,        │
  │    budget check, novelty check (embedding distance), policy check  │
  └───────────────┬────────────────────────────────────────────────────┘
                  ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │ 4. PRE-REGISTRATION: freeze the prediction, the metric, the gate,  │
  │    the decision rule and the horizon BEFORE generating anything    │
  └───────────────┬────────────────────────────────────────────────────┘
                  ▼
      generate → publish → wait for settling → evaluate (§6) → 
                  ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │ 5. REFLECTION (LLM, constrained): given the PRE-REGISTERED         │
  │    prediction and the ACTUAL posterior, write a memory record.     │
  │    Verdict is computed by code; the LLM writes only the rationale. │
  └────────────────────────────────────────────────────────────────────┘
```

The academic scaffolding for step 5 is Reflexion — agents that *"maintain reflective text in an episodic memory buffer to induce better decision-making in subsequent trials"* via verbal rather than gradient reinforcement (Shinn, Cassano, Berman, Gopinath, Narasimhan & Yao, https://arxiv.org/abs/2303.11366). For step 2, Zhou, Liu, Srivastava, Mei & Tan's hypothesis-generation framework is directly on point: generate initial hypotheses from a few examples, then update iteratively, with *"a reward function to inform the exploitation-exploration tradeoff in the update process"* over a hypothesis bank (https://arxiv.org/abs/2404.04326). **Our hypothesis bank's reward is not an LLM judgement — it is the realised posterior effect of the hypothesis's creatives.** That substitution is what makes it grounded.

### 10.3 Grounding: what the LLM is allowed to see

Three rules, each preventing a specific hallucination:

**(1) Never show a raw leaderboard.** Show *shrunk* posteriors with credible intervals and `n` (§7.2). An LLM handed `CPA: $12.40, conversions: 3` will call it the winner. Handed `CPA: $12.40 (raw, n=3) → shrunk $34.10, 90 % CI [$21, $76], P(better than incumbent) = 0.58` it will not.

**(2) Every number in the pack carries `n`, a CI, and a `provenance` tag** ∈ `{randomised, observational, meta_reported}`. Then instruct: *observational rows may be used to generate hypotheses, never to justify conclusions.* This is the operational form of Gordon et al.'s finding that observational methods fail to recover experimental effects at Facebook (https://doi.org/10.1287/mksc.2018.1135).

**(3) Ban causal verbs outside randomised evidence.** A schema-level constraint, not a prompt suggestion:

```jsonc
{
  "claim": "shorter hooks (<2.0s to first cut) reduce CPA in this account",
  "claim_type": "associational",          // associational | causal   <-- "causal" REJECTED by the
                                          //   validator unless evidence[].provenance == "randomised"
  "evidence": [{"id": "ev_8831", "n_conversions": 214, "effect": -0.14,
                "ci90": [-0.26, -0.02], "provenance": "randomised", "regime": "attr_2026_03"}],
  "scope": {"account_id": "act_123", "vertical": "dtc_supplements"},
  "confidence": 0.72,
  "expires_at": "2026-12-01"
}
```

A deterministic validator rejects the record if: `claim_type == "causal"` without randomised evidence; any `evidence.id` does not resolve; `n_conversions` is below the §6.4 threshold for the claimed effect size; or `regime` differs from the current attribution regime. **Rejection is silent to the user and logged — the LLM gets the validator's error and one retry.**

### 10.4 Memory as a queryable store, not prompt soup

Stuffing a growing "lessons learned" blob into the prompt fails in three ways: it grows without bound, it never forgets anything wrong, and it cannot be scoped (an insight about a supplements brand leaks into a plumber's campaign).

Ship a typed table instead:

```sql
CREATE TABLE learned_claims (
  id              text PRIMARY KEY,
  claim           text NOT NULL,
  claim_type      text NOT NULL CHECK (claim_type IN ('associational','causal')),
  lever           text,                -- which attribute this is about; NULL for structural claims
  scope_kind      text NOT NULL CHECK (scope_kind IN ('ad_set','account','vertical','global')),
  scope_id        text NOT NULL,
  effect_log      double precision,    -- effect on log CPA (portable across scales)
  effect_ci90_lo  double precision,
  effect_ci90_hi  double precision,
  n_conversions   integer NOT NULL,
  n_creatives     integer NOT NULL,
  provenance      text NOT NULL CHECK (provenance IN ('randomised','observational','meta_reported')),
  attribution_regime text NOT NULL,
  supersedes      text REFERENCES learned_claims(id),
  status          text NOT NULL CHECK (status IN ('active','superseded','refuted','expired')),
  last_confirmed  timestamptz NOT NULL,
  decay_halflife_days integer NOT NULL DEFAULT 90,
  created_at      timestamptz NOT NULL
);
CREATE INDEX ON learned_claims (scope_kind, scope_id, status, lever);
```

Retrieval into the prompt is then a *query*, not a dump: `WHERE status='active' AND ((scope_kind='account' AND scope_id=$1) OR (scope_kind='vertical' AND scope_id=$2) OR scope_kind='global') ORDER BY confidence_now DESC LIMIT 25`, where

```
confidence_now = base_confidence · 0.5 ^ ((now − last_confirmed) / decay_halflife_days)
```

Properties this buys you:
- **Forgetting is automatic and principled.** A claim not re-confirmed decays out of the prompt. Set `decay_halflife_days` shorter for creative-execution claims (60 d) than for structural ones (365 d).
- **Contradiction is representable.** New evidence writes a new row with `supersedes`, and the old row flips to `superseded`. You keep the audit trail, which matters when an advertiser asks "why did you stop doing the thing you told me worked?"
- **Refutation is a first-class event.** When a pre-registered hypothesis fails, the record is `refuted`, not deleted. Refuted claims are *valuable* — feed the top refuted claims back into the generator prompt as "things we have already tried in this account that did not work", which is the single most effective way to stop an LLM re-proposing the same idea every week.
- **Scope isolation.** A claim can never leak across accounts unless it was promoted to `vertical` or `global`, which requires a hierarchical fit (§7), not an LLM decision.

**Promotion rule (code, not LLM):** an account-scoped claim is promoted to vertical scope only when the hierarchical model's `δ_v` for that lever has a 90 % credible interval excluding zero *and* at least 3 distinct accounts contributed randomised evidence. This is the mechanism by which the platform's knowledge compounds across customers, and it must be conservative because a wrong global claim contaminates every new advertiser's cold start.

### 10.5 Preventing the LLM from poisoning its own evidence base

The generator chooses attributes; the model estimates attribute effects from the creatives the generator made. Left alone this is a positive feedback loop that converges to whatever the LLM believed on day one.

Countermeasures, in priority order:

1. **The forced-randomisation slice of §4.5.** 20 % of new creatives have their levers drawn from a fixed randomisation distribution the LLM does not see and cannot influence. This is non-negotiable — it is the only unconfounded evidence in the system.
2. **Lever balance monitoring.** Track the empirical distribution of each lever among exploit-assigned creatives. Alarm when any level's share exceeds e.g. 70 % — the model has collapsed and the coefficient for the dominated level is now unidentifiable.
3. **Novelty constraint.** Reject a generated creative whose embedding is within ε of an existing live creative (§4.6). Beyond diversity, this directly slows fatigue: near-duplicates share audience saturation.
4. **Adversarial prompt slot.** One creative per batch generated from an explicit "propose something that contradicts our current best-supported claim" instruction. Cheap, and it is the only mechanism that can escape a local optimum the whole system agrees on.

### 10.6 The evidence pack, concretely

What the LLM actually receives each cycle (all computed, none inferred):

```jsonc
{
  "as_of": "2026-09-02", "attribution_regime": "attr_2026_03",
  "account": {"vertical": "dtc_supplements", "target_cpa_minor": 4000, "currency": "USD",
              "weekly_budget_minor": 1400000, "capability_tier": "detect_large_differences"},
  "portfolio": [
    {"ad_id": "1201...", "creative_id": "cr_...", "age_days": 19,
     "spend_minor": 640000, "conversions": 158, "exposure_effective_minor": 619000,
     "cpa_shrunk_minor": 3920, "cpa_ci90_minor": [3480, 4430],
     "p_better_than_portfolio": 0.71, "impression_share_in_adset": 0.52,
     "frequency_7d": 2.4, "fatigue_state": "none",
     "hook_retention_p25": 0.61, "lpv_per_link_click": 0.78, "purchase_per_lpv": 0.031,
     "meta_recommendations": ["SCALE_GOOD_CAMPAIGN"]}
  ],
  "attribute_effects": [
    {"lever": "hook_archetype", "level": "problem_agitate", "effect_log_cpa": -0.11,
     "ci90": [-0.20, -0.02], "n_creatives": 23, "n_conversions": 611,
     "provenance": "randomised", "scope": "vertical"}
  ],
  "active_claims": [ /* from learned_claims, top 25 by confidence_now */ ],
  "refuted_claims": [ /* top 10 — 'we already tried this' */ ],
  "open_hypotheses": [ /* pre-registered, still settling — do NOT re-propose */ ],
  "capacity": {"creatives_this_cycle": 3, "randomised_slots": 1, "explore_budget_minor": 280000}
}
```

Note `capacity`: the LLM is told how many creatives it may propose and how many of those slots are randomised. **Never let the LLM decide how many creatives to make.** That number is a function of the exploration budget and the §6.4 power arithmetic, and it is the mechanism by which the statistics layer controls the generator's spend.

### 10.7 What the LLM is genuinely good at here

Being fair to the component: three jobs where it is not replaceable.

1. **Reading the video-retention curve and localising the failure.** `video_play_curve_actions` gives the exact per-second drop-off (`meta-insights-measurement.md` §8.3). "72 % drop between 1 s and 3 s, and the product does not appear until 2.4 s" → "re-cut so the product is in frame 0". No statistical model produces that instruction; an LLM with the creative brief and the curve does.
2. **The three-ratio funnel diagnosis.** `inline_link_click_ctr` → `landing_page_view_per_link_click` → `purchase_per_landing_page_view` localises whether the problem is hook, click-through or offer far better than any ranking string, and the *repair* differs completely by case. Meta's `quality_ranking` / `engagement_rate_ranking` / `conversion_rate_ranking` triage matrix (`meta-optimization-controls.md` §8.2 / `meta-insights-measurement.md` §8.2) is the same idea and should be fed in alongside.
3. **Turning a business input into an attribute prior.** A new advertiser has no data. "Local HVAC, $2,400 average job, emergency-driven demand, service area 20 miles" → a sensible starting point in attribute space (urgency hooks, trust/licence signals, no aspirational lifestyle footage) is exactly the kind of prior-setting an LLM does well and a regression cannot do at n=0.

---

## 11. Evaluating the autonomous system itself

### 11.1 Off-policy evaluation: what is and is not identified

**The impression level is hopeless.** Unbiased replay requires a uniformly-random logging policy — Li, Chu, Langford & Wang's method is *"provably unbiased"* precisely because *"the historical data must come from a uniformly random logging policy"* (https://arxiv.org/abs/1003.5956). Meta's delivery system is not uniform and does not expose its propensities. There is no `p(impression → ad a | user)` anywhere in the Marketing API. Any vendor claiming impression-level counterfactual evaluation of Meta creative is either running their own exchange or making it up.

Chapelle & Li hit exactly this wall on their own display-advertising data and said so plainly:

> *"A possible solution … is to use a replayer in which previous, randomized exploration data can be used to produce an unbiased offline estimator of the new policy [10]. Unfortunately, their approach cannot be used in our case here because it reduces the effective data size substantially when the number of arms K is large, yielding too high variance in the evaluation results. [15] studies another promising approach using the idea of importance weighting, but the method applies only when the policy is static, which is not the case for online bandit algorithms that constantly adapt to its history."*

Both objections apply to us verbatim: K (creatives) is large relative to data, and our policy adapts continuously.

**What *is* identified: our own policy.** We choose which creatives to launch, which to pause, and what budget to set. Those actions have known propensities **if and only if we log them**. That makes IPS and doubly-robust estimation available on the *creative-launch policy*, whose action space is small (a few levers × a few levels) and whose decisions number in the dozens per account-month rather than millions.

- **Doubly robust** (Dudík, Langford & Li, ICML 2011) is the right estimator: it is accurate *"when we have either a good (but not necessarily consistent) model of rewards or a good (but not necessarily consistent) model of past policy"* and has lower variance than IPS. https://arxiv.org/abs/1103.4601
- The reward model half is the hierarchical attribute model of §7; the propensity half is the logged TS allocation probabilities of §3.3. You already have both.
- Bottou et al.'s "Counterfactual Reasoning and Learning Systems" (with Bing's ad placement as the worked example) is the reference architecture for treating a live ad system as a causal system and estimating the effect of changes to it. https://arxiv.org/abs/1209.2355

**Concretely, log this for every launch decision:**
```jsonc
{"decision_id":"dec_...","ts":"...","context_hash":"...","candidate_set":["cr_a","cr_b","cr_c"],
 "propensities":{"cr_a":0.52,"cr_b":0.31,"cr_c":0.17},   // from the TS Monte Carlo, §3.3
 "chosen":"cr_a","assignment":"exploit","policy_version":"v7","seed":88123}
```
Without `propensities` and `policy_version`, none of the above is possible retroactively. It costs one JSON blob per decision and it is the difference between "we think it works" and "we can estimate what a different policy would have earned."

### 11.2 The three designs that actually produce a defensible answer

**(A) Paired switchback within account.** Alternate weeks: `AUTO` (full loop) vs `FROZEN` (baseline — no creative changes, no budget changes, everything left as-is). Compare log CPA within account across paired weeks.

Power, paired t-test on log CPA, α=0.05 two-sided, 80 % power, with week-to-week paired sd `σ_d = 0.25`:

| Effect to detect | Required pairs (account-weeks) |
|---|---|
| 10 % CPA improvement | **54** |
| 15 % | 25 |
| 20 % | **15** |
| 30 % | 7 |

54 pairs = 108 weeks in one account, or ~14 accounts × 4 pairs each. **This is the cheapest honest design and it should be the first thing built.** Its weaknesses: (i) carryover — a creative launched in an `AUTO` week keeps running in the `FROZEN` week, which *biases toward the null*, so a positive result is conservative; (ii) learning-phase resets at every switch, which inflates `σ_d`; (iii) it measures "loop on vs loop frozen", not "loop vs a good human".

Mitigate (i) by using long blocks (2-week alternation) and treating the first 3 days of each block as washout. Mitigate (ii) by switching only budget behaviour, not creative composition, in the low-cost variant.

**(B) Account-level randomisation across the fleet.** The clean design, available once you have enough advertisers. Unpaired, log CPA, between-account sd ≈ 0.5:

| Effect to detect | Accounts per arm |
|---|---|
| 10 % | **432** |
| 15 % | 192 |
| 20 % | **118** |
| 30 % | 54 |

Blocking on vertical and budget decile cuts these substantially; stratified randomisation is mandatory, not optional. **This is the design that would let you publish "our system beats Advantage+ defaults by X %"** and nothing cheaper will.

**(C) Geo holdout with synthetic control.** Meta open-sources GeoLift: *"an end-to-end geo-experimental methodology based on Synthetic Control Methods used to measure the true incremental effect (Lift) of ad campaign"*, maintained by Facebook Incubator and built on augmented synthetic control (`augsynth`). It exposes `GeoLiftMarketSelection`, `GeoLift` and `GeoLiftPower`.
Sources: https://github.com/facebookincubator/GeoLift , https://facebookincubator.github.io/GeoLift/docs/GettingStarted/Walkthrough

Practical details from the walkthrough: the worked example uses **40 US cities across 90 days**; the required columns are location, date (`yyyy-mm-dd`), and Y; locations with missing data or timestamps are dropped; **the test period should contain "at least one full purchase cycle"**; `GeoLiftPower` returns power at various effect sizes, the MDE, ATT, model fit via **L2 imbalance**, and required investment from **CPIC** (cost per incremental conversion); the default effect-size sweep is 0–25 % in 5 % increments.

Implementation on Meta: geo cells are `targeting.geo_locations` splits with mutual exclusion. This measures **incrementality of the whole channel**, not of the automation — useful for the advertiser, less useful for "does our loop beat theirs". Use it to answer "is this ad spend worth anything at all", which is the question Blake, Nosko & Tadelis showed most advertisers get badly wrong: at eBay, *"returns from paid search ads are a fraction of conventional non-experimental estimates"* and average returns were negative because heavy users, who drive most of the spend, were unaffected (NBER w20171, https://doi.org/10.3386/w20171).

**What NOT to do: before/after.** Gordon, Zettelmeyer, Bhargava & Chapsky ran the definitive test using Facebook's own data and found *"Observational methods often fail to accurately recover the treatment effects generated from randomized advertising experiments on Facebook"* (https://doi.org/10.1287/mksc.2018.1135). A "CPA improved 22 % after we turned on the AI" chart is not evidence and should not appear in the product.

### 11.3 The platform-native experiment surfaces, and their limits

- **`POST /v26.0/{BUSINESS_ID}/ad_studies` with `type=SPLIT_TEST`** is alive at v26.0 with no deprecation notice. Meta *"automates audience division, ensures no overlap between groups"*. Limits: *"Max concurrent studies per advertiser: 100"*, *"Max cells per study: 150"*, *"Max ad entities per cell: 100"*; guidance *"Select only one variable per test"*; duration 7–30 days with *"at least 2 weeks"* recommended. https://developers.facebook.com/docs/marketing-api/guides/split-testing/
- **`type=SPLIT_TEST_V2` + `creative_test_config`** is the creative-test path. **UNVERIFIED:** exact `creative_test_config` keys.
- **The Ads Manager creative test does not act on its results:** *"The test does not make any automatic changes based on the results"*, and it **requires the Highest volume bid strategy** (`LOWEST_COST_WITHOUT_CAP`), so it is unusable if you run `COST_CAP` or a ROAS floor. https://www.facebook.com/business/help/1423851372208214
- **`type=LIFT` (Conversion Lift) is rep-gated:** *"Conversion Lift Measurement is currently limited. Please contact your Meta Representative for information about obtaining access."* Assume unavailable for self-serve advertisers and design around it (`meta-insights-measurement.md` §10).
- **Meta computes its own winner by simulation:** *"Meta simulates possible outcomes tens of thousands of times to determine how often winning outcomes would have won"*, and `confidence_level` is a create parameter whose default Meta does not publish. **Compute your own posterior from raw Insights instead of trusting the study verdict.**

> **The ghost-ads benchmark, for calibration.** Johnson, Lewis & Nubbemeyer showed that identifying the control-group counterparts of exposed users lets *"advertisers measure lift just as precisely while spending at least an order of magnitude less"* (JMR 54(6), 2017, https://doi.org/10.1509/jmr.15.0297). That order of magnitude is what a platform-run lift study buys you and what you *cannot* replicate with targeting-based holdouts — which is why the gated `LIFT` study is genuinely valuable and why your own holdouts will always be ~10× more expensive for the same precision. Say that honestly rather than pretending your geo split is equivalent.

### 11.4 Beating Advantage+ defaults — the experiment to actually run

The strongest available comparison for a single advertiser:

```
Campaign X (control):  Advantage+ style defaults — CBO, LOWEST_COST_WITHOUT_CAP,
                       Advantage+ audience + placements, human-supplied creative, NO automation
Campaign Y (treatment): identical objective/audience/budget; our loop owns creative and budget
Mutual exclusion:      disjoint custom audiences, or geo split; monitor Auction Overlap Rate
Duration:              ≥ 4 weeks after both exit learning
Analysis:              posterior on log(CPA_Y / CPA_X) with the §5 completion correction
```

Honest expectations before you run it:
- With ~200 conversions per arm you can detect a **32 %** difference two-sided, or **14 %** with a one-sided Bayesian rule (§6.4). If the true difference is 8 %, this design will not find it, ever, in one account.
- Audience overlap will leak. Meta lists high auction overlap as a cause of Learning limited, and Auction Overlap Rate is documented as an **Ads Manager column** — **UNVERIFIED** whether it is exposed as an Insights field or breakdown at v26.0 (`meta-optimization-controls.md` §8.4). The structural proxy: flag when two active ad sets in one account have materially similar `targeting` specs.
- The honest claim after one account is *"no detected difference"*, not *"equivalent"*. The claim only becomes real at fleet scale (§11.2 design B).

### 11.5 The system's own scorecard

Track these continuously; they are leading indicators that the loop is healthy, and unlike CPA they are not confounded by the advertiser's market.

| Metric | Definition | Healthy direction |
|---|---|---|
| **Realised regret proxy** | `Σ spend × (CPA_realised − CPA_of_best_ad_in_hindsight) / CPA_best` | ↓ |
| **Creative hit rate** | share of launched creatives that reach `P_better ≥ 0.5` vs incumbent | 15–35 % is normal; >60 % means you are not exploring |
| **Time-to-kill** | median days from launch to a KILL verdict for creatives that get killed | ↓, but never below `attribution_window` |
| **Premature-kill rate** | share of killed creatives whose *settled* 28-day posterior would not have triggered KILL | **< 5 %** — this is the §5.4 bug's alarm |
| **Exploration efficiency** | conversions bought per unit of posterior variance reduction on attribute coefficients | ↑ |
| **Learning-phase occupancy** | % of ad-set-days with `learning_stage_info.status == 'LEARNING'` | **< 30 %** — above that the loop is editing too much (§2.6) |
| **Surrogate validity** | Kendall τ between day-2 impression share and settled 7-day CPA rank | ≥ 0.3, per account (§2.5) |
| **Claim survival** | share of `learned_claims` that survive their next re-test | ↑; a low rate means the hypothesis loop is generating noise |
| **Coverage calibration** | share of 90 % predictive intervals that contain the realised outcome | ≈ 0.90 — this is the single best test that the whole probabilistic stack is honest |

The last one deserves emphasis. **Log a prediction with an interval for every creative you launch, then score it.** If your 90 % intervals contain the truth 60 % of the time, every downstream decision threshold is miscalibrated and the fix (usually: `σ²_ad` too small, or the delay correction missing) is diagnosable. Chapelle & Li's own calibration check — *"when constructing a 95 % confidence interval for CTR, the true CTR is in this interval 95.1 % of the time"* — is the standard to hold yourself to.

---

## 12. Safety: caps, anomalies, circuit breakers, and approvals that don't kill autonomy

### 12.1 Layered spend caps

| Layer | Mechanism | Notes |
|---|---|---|
| Our own ledger | daily/weekly/monthly budget per account in our DB, checked before every write | the only cap that is *ours*; everything below is Meta's and lags |
| Campaign | `spend_cap` on the campaign object — lifetime ceiling, **minimum $100 USD** or local equivalent; set to `922337203685478` to remove | `meta-campaign-publishing.md` §, https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group |
| Ad set (non-CBO only) | `daily_spend_cap` / `lifetime_spend_cap`; `922337203685478` removes | **do not use under CBO** — constrains the campaign pacer |
| Ad account | account-level spend cap | set at onboarding as the last line of defence |
| Structural | `status=PAUSED` | the real kill switch |

> **`DELETE` is not a kill switch.** *"A deleted ad may still accrue impressions/clicks/actions for 28 days after delivery"* (https://developers.facebook.com/docs/marketing-api/reference/ad-account/). Use `status=PAUSED` to stop spend; delete only as garbage collection against the 6,000-object account ceiling.

> **The 175 % anchor makes over-spend one-directional.** See §8.4. Every automated upward budget write must pass a monotone daily high-water check *in your code*, because Meta will not let you take it back.

### 12.2 Anomaly detection worth having

Ordered by expected value, not sophistication:

1. **Spend velocity.** Compare spend-so-far-today against the account's own hour-of-day profile. Alarm at >2.5× the p95 of the trailing 28 days for that hour. Catches: runaway budget writes, a duplicated campaign, an HDP misfire.
2. **Conversion-rate collapse (data integrity first).** A sudden drop in conversions-per-click is more often a broken pixel, a CAPI outage, a consent-banner change, or a checkout deploy than a creative problem. **Cross-check against your own CAPI ingest count before any optimiser reaction**; if CAPI is flat and Meta-reported conversions collapsed, the fault is on the reporting side and the correct action is HOLD, not KILL.
3. **Delivery collapse.** `impressions == 0` for >6 h on an `ACTIVE` ad set with a non-zero budget. Causes: `effective_status` moved to `WITH_ISSUES`/`DISAPPROVED`, payment failure, audience exhaustion, a targeting edit that produced an empty audience.
4. **CPA z-score at the account level**, computed against the *control creative* index (§9.1) so that a market-wide shift does not trip it.
5. **Portfolio concentration.** One ad taking >85 % of impressions for >5 days. Not an error, but it is the precondition for a fatigue cliff with nothing to switch to.
6. **Learning-phase occupancy** > 50 % of ad-set-days over a week — the loop is thrashing (§2.6).
7. **Rate-limit and error-budget monitors.** The insights quota formula is `ads_insights = (190000 if Full access else 600) + 400 × ActiveAds − 0.001 × UserErrors` — **your own 4xx errors reduce your quota**, so a retry storm is doubly punished (`meta-insights-measurement.md` §11.1). Alarm on error rate, not just on 429s. (Full Access also requires keeping the error rate under 15 % of the last 500 calls.)

### 12.3 Circuit breakers with hysteresis

```
CLOSED   → normal autonomous operation
HALF_OPEN→ read-only: keep syncing and computing, but suppress all writes except PAUSE
OPEN     → pause all ACTIVE objects in the account, page a human
```

Transitions:
- `CLOSED → HALF_OPEN` on any single anomaly from §12.2 above threshold, or on 3 consecutive failed Meta writes, or on a Graph API error class you do not have an explicit handler for.
- `HALF_OPEN → OPEN` on a spend anomaly, on `spend_today > 1.5 × daily_budget_sum` (the 175 % ceiling means 1.75× can be legitimate — 1.5× with an internal anomaly is not), or on a second distinct anomaly.
- `OPEN → HALF_OPEN` **only by human action.** Never auto-close from OPEN.
- `HALF_OPEN → CLOSED` automatically after 6 h with no anomalies **and** a successful full sync.

Two properties that keep this from being useless:
- **Hysteresis.** Different thresholds for opening and closing, and a minimum dwell time in each state. Without it a flapping metric produces a pause/resume loop, and pausing an ad set for ≥7 days restarts learning on resume (https://www.facebook.com/business/help/316478108955072).
- **Pause is safe; unpause is not.** The breaker may pause autonomously. Resuming spend after an OPEN state is a human decision. That asymmetry is the whole design.

### 12.4 Human approval checkpoints that preserve autonomy

The design principle: **gate on novelty and magnitude, never on frequency.** Approving every action destroys autonomy and trains the human to click yes. Approving rare, high-consequence, *novel* actions preserves it.

| Gate | Trigger | Default if no response |
|---|---|---|
| **Onboarding** | first campaign for a new account; domain verification and the 8 AEM event slots (an Events Manager UI step — a genuine human gate, `meta-insights-measurement.md` §4.6) | blocked (cannot proceed) |
| **Budget band** | requested budget outside `[0.5×, 2×]` of the human-approved band | keep current budget |
| **New claim family** | a creative brief that introduces a lever level never used in this account (e.g. first time using a testimonial claim) | do not generate |
| **Regulated content** | health/finance/employment/housing/credit claims, or anything matching the special-ad-category rules | do not publish |
| **Spend step change** | total account spend increase > 30 % week-over-week | apply 30 %, queue the rest |
| **Circuit breaker OPEN** | see §12.3 | stay paused |

Everything else — creative generation, launch, pause, ±20 % budget moves, ad-set rebuilds within the approved band — runs unattended.

**Make the default action safe, and make silence mean "no change".** An approval request that times out must never fall through to "proceed". And every gate must have a *pre-authorisation* form: an advertiser who sets a monthly budget band once should not be asked again every week. The approval UX is where autonomy is usually lost, not the algorithm.

### 12.5 Operational hygiene that prevents the expensive class of bug

- **Idempotency keys on every mutating call**, stored before the request and checked after. Meta will occasionally return a timeout on a request that succeeded; a naive retry creates a duplicate campaign that spends real money.
- **`validate_only` dry runs.** `execution_options` accepts `validate_only` and `include_recommendations` (the latter *"cannot be used by itself and requires specifying the `validate_only` flag with it"*). **UNVERIFIED** whether that 2016 contract is unchanged at v26.0 — the dedicated validation doc page 404s (`meta-optimization-controls.md` §10).
- **Create everything `PAUSED`, verify, then activate.** `status_option` on `/copies` defaults to `PAUSED`, which is the right default. Publish order: campaign → ad set → creative → ad, all paused; read back `advantage_state_info`, `issues_info`, `effective_status`; then flip to `ACTIVE` in one batch.
- **Shadow mode.** Run the full decision loop against a live account, log every action it *would* have taken, execute none. Two weeks of shadow logs will reveal the delay-bias bug of §5.4 and the thrashing bug of §2.6 before either costs money. This is the highest-value pre-launch investment in the entire project.
- **`adlabels` as the control plane.** Adding/removing labels is not on Meta's significant-edit list, so labels are a free place to store your own metadata (`hypothesis_id`, `assignment`, `policy_version`) on the objects themselves — which makes the account self-describing if your database is ever out of sync with reality.
- **Never let a native Automated Rule and your loop govern the same object.** Rules retroactively adopt new objects matching an `entity_type` filter, so a rule written in January will act on ad sets your pipeline creates in September — including ones inside a protected learning window. Scope native rules by `id` or `hours_since_creation`, and keep them to guardrails that must fire when your own infrastructure is down.

---

## 13. Reference architecture for the decision loop

### 13.1 The tables that must exist

```sql
-- IMMUTABLE FACTS ------------------------------------------------------------
insights_daily(date_start, date_stop, level, object_id, breakdown_key,
               spend_minor, impressions, reach, clicks, inline_link_clicks,
               conversions, conversion_value_minor, action_type, attribution_window,
               attribution_setting, attribution_regime, fetched_at, is_settled)
      PRIMARY KEY (date_start, level, object_id, breakdown_key, action_type, attribution_window)
      -- upserted on a ROLLING 28-DAY re-fetch; `is_settled` flips at date_start + 28d

creatives(creative_id, ad_id, adset_id, campaign_id, account_id,
          attributes_jsonb, attributes_schema_version, assignment, parent_creative_id,
          hypothesis_id, embedding vector(768), created_at, launched_at, paused_at)

decisions(decision_id, ts, account_id, kind, object_id, policy_version, seed,
          candidate_set jsonb, propensities jsonb, chosen, inputs_hash,
          predicted_effect, predicted_ci90, executed, meta_request_id, idempotency_key)

-- DERIVED / MUTABLE ----------------------------------------------------------
completion_curve(account_id, attribution_window, age_days, F, n_cohorts, fitted_at)
posteriors(object_id, level, k, rate, gamma_discount, as_of, model_version)
attribute_effects(scope_kind, scope_id, lever, level, effect_log, ci90_lo, ci90_hi,
                  n_creatives, n_conversions, provenance, fitted_at)
learned_claims(...)            -- §10.4
regime_events(account_id, ts, kind, description)   -- attribution changes, pixel outages, price changes
hypotheses(hypothesis_id, created_at, lever, prediction, gate, horizon_days,
           status, preregistered_at, verdict, verdict_computed_at)
```

Three non-negotiables:
1. **`insights_daily` is append-and-upsert over a rolling 28-day window, keyed to include `attribution_window` and `attribution_regime`.** Anything less silently under-reports and makes historical comparisons meaningless.
2. **`decisions.propensities` is written before the action executes**, not after. It is the only thing that makes §11.1 possible.
3. **`predicted_effect` / `predicted_ci90` on every decision.** This is what powers the calibration metric in §11.5, and it is free to write and impossible to reconstruct later.

### 13.2 The cadence

| Job | Frequency | What it does | Why not faster |
|---|---|---|---|
| Guardrail sweep | 15 min | spend velocity, delivery collapse, `effective_status`, circuit breaker | Insights refresh is ~15 min; faster is pure quota waste |
| Insights sync | hourly (today) + daily (rolling 28 d) | upsert `insights_daily` | 28-day mutability |
| Posterior update | daily, 06:00 account TZ | completeness-correct, discount, update Gamma posteriors | conversions settle on a daily clock |
| Budget decision | daily, before noon account TZ | §8.5 | Meta: *"2-3 times a day and only the early part of the day"* |
| Creative decision | **weekly**, one maintenance window | all pauses + all launches, batched | every add/remove is a significant edit; batching costs one reset instead of N |
| Hierarchical refit | nightly | attribute effects, fatigue rates, completion curves | batch job, minutes |
| Hypothesis cycle | weekly, after the creative window | evidence pack → LLM → admission → pre-registration | matched to the creative window |
| Claim maintenance | weekly | decay, supersede, promote to vertical scope | — |

**The weekly creative window is the single most important scheduling decision.** Trickling one ad at a time into a live ad set restarts learning every time. One batched window per week costs one reset and gives the ad set six days to stabilise.

### 13.3 The weekly creative decision, in full

```python
def weekly_creative_window(account, now):
    F   = completion_curve(account)                      # §5.3
    post= {a.id: gamma_posterior(a, F, gamma=0.95) for a in account.active_ads}   # §3.2, §9.2
    inc = incumbent(post)                                # best shrunk posterior with n above gate

    # ---- 1. EVALUATE ---------------------------------------------------------
    verdicts = {}
    for a in account.active_ads:
        if not gates_pass(a, now):                       # §6.5
            verdicts[a.id] = "HOLD:gated"; continue
        d_new, d_inc = draw(post[a.id]), draw(post[inc.id])
        p_worse = mean(cpa(d_new) > cpa(d_inc) * (1 + X))
        p_bettr = mean(cpa(d_new) < cpa(d_inc))
        if   p_worse >= 0.80:                     verdicts[a.id] = "KILL"
        elif p_bettr >= 0.85:                     verdicts[a.id] = "SCALE"
        elif rope(d_new, d_inc, X) >= 0.90:       verdicts[a.id] = "EQUIVALENT"
        else:                                     verdicts[a.id] = "HOLD"

    # ---- 2. FATIGUE / META SIGNALS ------------------------------------------
    for r in meta_recommendations(account):              # GET /act_{id}/recommendations
        if r.type in ("CREATIVE_FATIGUE", "CREATIVE_LIMITED"):
            for oid in r.object_ids: verdicts[oid] = "REPLACE"

    # ---- 3. CAPACITY --------------------------------------------------------
    n_slots  = floor(explore_budget(account) / min_test_spend(account))     # §8.3
    n_random = max(1, round(0.20 * n_slots)) if n_slots else 0

    # ---- 4. GENERATE --------------------------------------------------------
    briefs = llm_propose(evidence_pack(account, post, verdicts),
                         n=n_slots - n_random)                              # §10.6
    briefs += [randomised_brief(account) for _ in range(n_random)]          # §4.5
    briefs  = [b for b in briefs if admission_control(b)]                   # dedupe/novelty/policy

    # ---- 5. EXECUTE, ALL IN ONE BATCH ---------------------------------------
    with maintenance_window(account):                    # ONE significant edit, not N
        for aid, v in verdicts.items():
            if v in ("KILL", "REPLACE"): pause(aid)
        for b in briefs:
            cr = publish_creative(generate_video(b))     # POST /adcreatives
            publish_ad(cr, target_adset(account, b), status="PAUSED")
        activate_all_pending(account)
    record_decisions(...)                                # propensities, predictions, seeds
```

Four things this pseudocode encodes that are easy to lose:
- **The incumbent is a posterior, not "the ad with the lowest CPA".**
- **`EQUIVALENT` is a real verdict** and stops re-litigation (§6.2).
- **Meta's own `CREATIVE_FATIGUE` recommendation overrides our verdict upward to REPLACE** — Meta sees the historical cost-per-result benchmark we may not have.
- **All mutations happen inside one window.** If you take one idea from this document into the code, take that one.

---

## 14. Gotchas

1. **Age-confounded killing (§5.4).** A 2-day-old ad shows ~55 % of its conversions; a 7-day-old ad ~95 %. Comparing them directly systematically kills new creative. The symptom is "the AI rejects everything it makes". Fix: completeness-weighted exposure, age-matched cohorts, and a minimum-age gate.
2. **Discounting raw counts.** Discounting (§9.2) up-weights recent data, which is under-reported. **Completeness-correct first, then discount.** Doing it in the wrong order makes the system permanently pessimistic about the present.
3. **Summing `actions[].value`.** The array contains overlapping roll-ups (`purchase` ⊃ `offsite_conversion.fb_pixel_purchase`, …). Pick exactly one `action_type` and hard-code it.
4. **`7d_view` / `28d_view` return zeros, not errors,** since 2026-01-12. A naive request silently reports a fraction of the truth.
5. **Daily ROAS is not a cohort.** Since 2025-06-10 Meta reports as `action_report_time=mixed`: spend is impression-dated, web purchases are conversion-dated. Fine for parity with Ads Manager; wrong for marginal-return curves.
6. **Rows in one response can have different `attribution_setting`.** Never aggregate across them without requesting an explicit `action_attribution_windows` key.
7. **Ad-level CPA inside a shared ad set is not a creative effect.** Meta assigned those impressions adaptively. It is an exploitation signal, not an evaluation signal.
8. **Ad-set-level cost under CBO is a distorted number.** The "bad" ad set may be cheap *because* it is starved. Never feed it into a budget decision.
9. **The 175 % daily overspend ceiling anchors to the highest budget set that day.** Writing a large budget then writing it back does not undo it. Guard upward writes with a monotone daily high-water mark.
10. **The weekly 7× ceiling resets Saturday midnight in the ad account timezone**, not on a rolling window.
11. **Adding one ad to a live ad set restarts learning for the whole ad set.** Batch every creative swap into one weekly window.
12. **Pausing an ad set for ≥7 days restarts learning on resume.** For longer than a week, archive and rebuild.
13. **`learning_stage_info.status = FAIL` means "Learning limited", not an error.** There is no `LEARNING_LIMITED` value.
14. **Use `dynamic_lp_conversions_threshold` / `dynamic_lp_days_threshold` when populated**, not the folklore 50.
15. **The "20 % budget change" rule is folklore.** Meta publishes no percentage. The only reliable signal is whether `last_sig_edit_ts` moved after your write — measure it.
16. **`roas_average_floor` is scaled ×10000** (2.5× → `25000`) while `bid_amount` is in currency minor units. Two scaling conventions in one object.
17. **Meta's own written limit on optimization actions is "2-3 times a day and only the early part of the day"**, and the API enforces nothing. Enforce it yourself.
18. **`DELETE` is not a kill switch** — deleted ads may accrue actions for 28 days. Use `status=PAUSED`.
19. **Your own 4xx errors reduce your insights quota** (`− 0.001 × UserErrors` in the formula). A retry storm against a malformed query is punished twice.
20. **Native Automated Rules retroactively adopt newly-created objects** matching an `entity_type` filter, including ad sets inside a protected learning window. Scope by `id` or `hours_since_creation`.
21. **`ROTATE` is round-robin by ad ID, one active ad at a time, performance-blind.** It is not a creative-testing primitive.
22. **Dynamic Creative / Flexible Ad Format destroy per-video attribution.** Asset-level breakdowns support only `impressions, clicks, spend, reach, actions, action_values` — no ROAS, no video retention. One generated video = one ad = one clean row.
23. **`frequency_value` breakdown works exclusively with `reach`.** You cannot get conversions bucketed by frequency in the same call.
24. **A change-point detector that can pause ads will eventually pause an account on a reporting glitch.** Its only correct output is HOLD + widen posteriors.
25. **Unshrunk leaderboards poison LLMs.** The top of a raw CPA leaderboard is always the lowest-n ads. Show shrunk posteriors with `n` and a CI, or the model will confidently over-fit noise.
26. **Empirical Bayes without the Poisson-noise subtraction does nothing.** If you estimate between-ad variance without subtracting the sampling term, `Var(θ)` inflates, `r₀` collapses, and shrinkage silently becomes a no-op.
27. **Hierarchical fits weighted by row are dominated by your largest account.** Weight by account or cap each account's likelihood contribution, or your "cross-vertical creative science" is one advertiser's taste.
28. **50 conversions per arm supports only a ~75 % two-sided MDE.** Any claim of statistically-detected 10–20 % creative differences at that sample size is false.
29. **Before/after is not evidence.** Facebook's own data shows observational methods fail to recover experimental effects (Gordon et al. 2019).
30. **CBO campaigns with >70 ad sets cannot change `bid_strategy` or turn CBO off.** A runaway ad-set spawner can permanently lock a campaign's configuration.
31. **50 non-archived ads per ad set; 6,000 non-archived objects per account.** A generative pipeline hits these. Plan the GC job before launch, not after.
32. **An LLM given Meta API credentials is a spend incident waiting to happen.** Its only write path should be a queue the statistics layer gates.

---

## 15. Open questions / UNVERIFIED

1. **The exact likelihood in Chapelle (2014).** The exponential-delay assumption is verified via Yoshikawa & Imai; the algebra in §5.2 is a faithful reconstruction, not a quotation. The author's PDF returns 403 through this environment's proxy. Re-verify before implementing the parametric version.
2. **Real conversion-delay curves.** The `F(a)` table in §5.3 is illustrative. Every account's curve must be fitted from its own settled cohorts. I have no citable public source for Meta-specific delay distributions.
3. **Attribute-model R².** I found no public source quantifying how much of Meta conversion performance creative attributes explain. Assume `σ²_ad` dominates until measured, and treat any vendor claim of high predictive power as unverified.
4. **Whether a `budget_schedules` HDP counts as a significant edit.** Not on Meta's published list, which is suggestive but not conclusive. Measure with `last_sig_edit_ts`.
5. **`creative_test_config` key names and value ranges** for `SPLIT_TEST_V2`. Not published.
6. **The default `confidence_level` on `ad_studies`**, and its exact semantics (posterior probability of superiority is the natural reading given Meta's "simulates possible outcomes tens of thousands of times" description). Unpublished.
7. **Whether Auction Overlap Rate is available via the Insights API** at v26.0, or is Ads Manager-only. If Ads Manager-only, the structural proxy (similar `targeting` specs across active ad sets) is the fallback.
8. **What populates the `incrementality`, `incrementality_all_conversions`, `incrementality_first_conversion` keys** now present in `AdsActionStats` and the `action_attribution_windows` enum. No public documentation. If they are populated for self-serve accounts they would be a dramatically cheaper incrementality read than a gated Lift study — probe them early.
9. **Whether the 2016 `validate_only` + `include_recommendations` contract is unchanged at v26.0.** The dedicated validation doc page 404s.
10. **The engage-through (`1d_ev`) default attribution setting** for conversion campaigns post-March-2026 is reported as 7-day click / 1-day engage-through / 1-day view by secondary sources only. Verify by reading `attribution_setting` off a live ad set.
11. **`creative_fatigue_summary`, `creative_diversity_score`, `opportunity_score_l4`, `attention_events_per_impression` JSON sub-shapes.** Present in the v26.0 field table with no per-field documentation. Discover empirically.
12. **Whether Meta's within-ad-set allocation is itself Thompson-sampling-like or a deterministic eAR ranking.** Meta publishes the *"total value"* formula but not the exploration mechanism. This matters for §2.5: if Meta's allocation is deterministic, impression share is a much noisier surrogate than if it randomises. Not documented anywhere I could verify; treat the surrogate-validity check (Kendall τ) as the empirical answer.
13. **Whether the fleet-scale account-randomisation design (§11.2 B) is legally/contractually permissible** — deliberately running a worse policy on paying customers' accounts is an ethics and terms-of-service question, not a statistics question. Resolve it before designing the experiment. A "hold out the newest feature, not the whole system" design is the usual compromise.
14. **Optimal `γ` (discount) and `α` (posterior reshaping) values for this domain.** Chapelle & Li's `α = 0.5` came from display CTR at enormous scale. Our regime is different by orders of magnitude. These are the two knobs to tune first once the fleet produces data.

---

## 16. Source index

**Meta platform (primary)**
- Graph API changelog / current version: https://developers.facebook.com/docs/graph-api/changelog
- Insights best practices (15-min refresh, 28-day immutability): https://developers.facebook.com/docs/marketing-api/insights/best-practices/
- Ads action stats (`1d_ev`, `dda`, `incrementality`, window keys): https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/
- Insights breakdowns (asset-level metric ceiling, `frequency_value`): https://developers.facebook.com/docs/marketing-api/insights/breakdowns/
- Out-of-cycle changes 2025 (`action_report_time`/`use_unified_attribution_setting` disregarded): https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2025/
- Metric availability update (7d/28d view removal): https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/
- Engage-through attribution: https://www.facebook.com/business/news/click-attribution
- Learning stage info node: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-learning-stage-info/
- Pacing and scheduling ("2-3 times a day"): https://developers.facebook.com/docs/marketing-api/bidding/overview/pacing-and-scheduling
- Bid strategy: https://developers.facebook.com/docs/marketing-api/bidding/overview/bid-strategy/
- Advantage+ campaign budget: https://developers.facebook.com/docs/marketing-api/bidding/guides/advantage-campaign-budget/
- Minimum budgets: https://developers.facebook.com/docs/marketing-api/reference/minimum-budget/
- Budget schedules / high-demand periods: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/budget_schedules/
- Split testing guide + limits: https://developers.facebook.com/docs/marketing-api/guides/split-testing/
- Ad study node: https://developers.facebook.com/docs/marketing-api/reference/ad-study/
- Performance recommendations / Opportunity Score: https://developers.facebook.com/docs/marketing-api/overview/performance-recommendations/
- Ad rules execution spec (`ROTATE`): https://developers.facebook.com/docs/marketing-api/ad-rules/overview/execution-spec/
- Rate limiting: https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting

**Meta help centre (verbatim policy language)**
- Ad auction / total value: https://www.facebook.com/business/help/430291176997542
- About daily budgets (75 % / 7× / 175 %): https://www.facebook.com/business/help/190490051321426
- About the learning phase (~50 events): https://www.facebook.com/business/help/112167992830700
- Significant edits and learning phase: https://www.facebook.com/business/help/316478108955072
- Learning limited: https://www.facebook.com/business/help/269269737396981
- Best practices for delivery (consolidate, 6+ placements): https://www.facebook.com/business/help/950694752295474
- Creative limited / creative fatigue thresholds: https://www.facebook.com/business/help/1346816142327858
- Even ad delivery / one ad per ad set: https://www.facebook.com/business/help/464145940405064
- Creative test (2–7 copies, ≤20 % budget, no auto-action): https://www.facebook.com/business/help/1423851372208214
- Budget scheduling limits (50 HDPs, 3 h, 8×): https://www.facebook.com/business/help/633318028866693
- Auction overlap rate: https://www.facebook.com/business/help/714172578779451
- Ad set spend limits under CBO: https://www.facebook.com/business/help/458847204894307

**Bandits**
- Chapelle & Li, *An Empirical Evaluation of Thompson Sampling*, NIPS 2011 — delay table, posterior reshaping, Algorithm 3, display-ads regret table: https://proceedings.neurips.cc/paper_files/paper/2011/hash/e53a0a2978c28872a4505bdb51db06dc-Abstract.html
- Scott, *A modern Bayesian look at the multi-armed bandit*, ASMBI 26(6):639–658, 2010: https://doi.org/10.1002/asmb.874
- Li, Chu, Langford & Schapire, *A Contextual-Bandit Approach to Personalized News Article Recommendation* (LinUCB), WWW 2010: https://arxiv.org/abs/1003.0146
- Agrawal & Goyal, *Thompson Sampling for Contextual Bandits with Linear Payoffs*: https://arxiv.org/abs/1209.3352
- Hill, Nassif, Liu, Iyer & Vishwanathan, *An Efficient Bandit Algorithm for Realtime Multivariate Optimization*, KDD 2017 (Amazon, +21 % conversion in one week): https://arxiv.org/abs/1810.09558
- Chen et al., *Automated Creative Optimization for E-Commerce Advertising* (AutoCO, Alibaba, +7 % CTR), WWW 2021: https://arxiv.org/abs/2103.00436

**Delayed / censored feedback**
- Chapelle, *Modeling delayed feedback in display advertising*, KDD 2014: https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/2623330.2623634 (PDF: http://olivier.chapelle.cc/pub/delayedConv.pdf — 403 via this proxy)
- Yoshikawa & Imai, *A Nonparametric Delayed Feedback Model for Conversion Rate Prediction*: https://arxiv.org/abs/1802.00255
- Vernade, Cappé & Perchet, *Stochastic Bandit Models for Delayed Conversions*, UAI 2017: https://arxiv.org/abs/1706.09186
- Ktena et al., *Addressing Delayed Feedback for Continuous Training with Neural Networks in CTR prediction*, RecSys 2019 (+55 % RPMq vs naive log loss): https://arxiv.org/abs/1907.06558

**Non-stationarity**
- Garivier & Moulines, *On Upper-Confidence Bound Policies for Non-Stationary Bandit Problems*: https://arxiv.org/abs/0805.3415
- Liu, Lee & Shroff, *A Change-Detection based Framework for Piecewise-stationary Multi-Armed Bandit Problem* (CUSUM-UCB, PHT-UCB), AAAI 2018: https://arxiv.org/abs/1711.03539

**Sequential / Bayesian decision rules**
- Johari, Pekelis & Walsh, *Always Valid Inference: Bringing Sequential Analysis to A/B Testing*: https://arxiv.org/abs/1512.04922
- Howard, Ramdas, McAuliffe & Sekhon, *Time-uniform, nonparametric, nonasymptotic confidence sequences*, Ann. Statist. 49(2):1055–1080, 2021: https://arxiv.org/abs/1810.08240
- Stucchio, *Bayesian A/B testing decision rule / expected loss*: https://www.chrisstucchio.com/blog/2014/bayesian_ab_decision_rule.html
- Robinson, *Understanding empirical Bayes estimation* (shrinkage exposition): http://varianceexplained.org/r/empirical_bayes_baseball/ (503 at time of writing; formula reproduced from the standard beta-binomial result)

**Adaptive-data inference & off-policy evaluation**
- Zhang, Janson & Murphy, *Inference for Batched Bandits* (BOLS), NeurIPS 2020: https://arxiv.org/abs/2002.03217
- Hadad, Hirshberg, Zhan, Wager & Athey, *Confidence Intervals for Policy Evaluation in Adaptive Experiments*: https://arxiv.org/abs/1911.02768
- Li, Chu, Langford & Wang, *Unbiased Offline Evaluation of Contextual-bandit-based News Article Recommendation Algorithms* (replay), WSDM 2011: https://arxiv.org/abs/1003.5956
- Dudík, Langford & Li, *Doubly Robust Policy Evaluation and Learning*, ICML 2011: https://arxiv.org/abs/1103.4601
- Bottou et al., *Counterfactual Reasoning and Learning Systems* (Bing ad placement): https://arxiv.org/abs/1209.2355

**Advertising measurement economics**
- Lewis & Rao, *The Unfavorable Economics of Measuring the Returns to Advertising*, QJE 130(4), 2015: https://doi.org/10.1093/qje/qjv023
- Gordon, Zettelmeyer, Bhargava & Chapsky, *A Comparison of Approaches to Advertising Measurement: Evidence from Big Field Experiments at Facebook*, Marketing Science, 2019: https://doi.org/10.1287/mksc.2018.1135
- Johnson, Lewis & Nubbemeyer, *Ghost Ads: Improving the Economics of Measuring Online Ad Effectiveness*, JMR 54(6), 2017: https://doi.org/10.1509/jmr.15.0297
- Blake, Nosko & Tadelis, *Consumer Heterogeneity and Paid Search Effectiveness: A Large Scale Field Experiment* (eBay), NBER w20171, 2014: https://doi.org/10.3386/w20171

**Budget allocation / response curves / geo experiments**
- Google Meridian model spec (Adstock and Hill functional forms): https://developers.google.com/meridian/docs/basics/model-spec
- Meridian budget optimization scenarios (marginal-ROI equalisation, spend constraints): https://developers.google.com/meridian/docs/user-guide/budget-optimization-scenarios
- Meta GeoLift (synthetic control geo experiments): https://github.com/facebookincubator/GeoLift , https://facebookincubator.github.io/GeoLift/docs/GettingStarted/Walkthrough
- Xu, Lee, Li, Qi & Lu, *Smart Pacing for Effective Online Ad Campaign Optimization*, KDD 2015: https://arxiv.org/abs/1506.05851

**LLM loops**
- Shinn, Cassano, Berman, Gopinath, Narasimhan & Yao, *Reflexion: Language Agents with Verbal Reinforcement Learning*: https://arxiv.org/abs/2303.11366
- Zhou, Liu, Srivastava, Mei & Tan, *Hypothesis Generation with Large Language Models*, NLP4Science @ EMNLP 2024: https://arxiv.org/abs/2404.04326

**Sibling dossiers in this repository**
- `docs/research/meta-api-foundations.md`, `meta-campaign-publishing.md`, `meta-insights-measurement.md`, `meta-optimization-controls.md`, `meta-video-creative.md`, `meta-policy-compliance.md`, `creative-production-pipeline.md`, `video-gen-google-veo.md`, `video-gen-byteplus-seedance.md`
