# What I need from you

You run Path A: you own the Business portfolio, the Pages and the ad accounts. That is the
easy path — **no App Review, no Business Verification, no screencast**. Standard Access is
legally sufficient because Meta exempts *"a role in a Business that has claimed the app."*
You can complete everything below in an afternoon.

Nothing here should be pasted into chat. Put it in `.env` (git-ignored) and run
`npm run preflight`, which verifies every item and tells you exactly what is missing.

---

## A. The five things I actually need

### 1. A Meta app of type **Business**, connected to your Business portfolio

App Dashboard → Create App → **Business** → then Settings → connect it to the business
portfolio that owns your Pages and ad accounts. The connection is what grants the Standard
Access exemption; without it you are back to App Review.

Then App Settings → Advanced → Security → turn **Require App Secret** ON. Every call this
system makes is server-side and already signs with `appsecret_proof`, so the toggle costs
nothing and closes off token replay from a browser.

Give me: `META_APP_ID`, `META_APP_SECRET`.

### 2. A **system user** token, never-expiring

Business Settings → Users → System Users → Add. Give it **Admin** access.

Order matters and the error message when you get it wrong (`#100`) does not tell you the
order is the problem. It is:

1. system user exists in the business
2. install the app for it — `POST /{system-user-id}/applications` with `business_app={app_id}`
3. assign assets to it (below)
4. *then* mint the token

Mint with these scopes and **omit** `set_token_expires_in_60_days` so it never expires:

```
ads_management, ads_read, business_management,
pages_show_list, pages_read_engagement, pages_manage_ads,
instagram_basic, read_insights
```

Add `leads_retrieval` now if lead ads are ever in scope — retrieving leads is impossible
without it and adding it later means re-minting.

Give me: `META_SYSTEM_USER_TOKEN`.

### 3. Asset assignments to that system user

In Business Settings, assign to the system user:

- **every ad account** you want automated — with **Manage campaigns** permission
- **every Page** you want to advertise from — with **Manage Page / Ads** task
- the **pixel / dataset** for each brand, if you run website conversions

The system user must already be a business member before assignment succeeds.

`preflight` discovers these itself from the token, so you do not need to send me IDs —
but it also means an unassigned asset is invisible rather than merely unavailable.

**Granting the scope is not the same as granting the asset.** A system user can hold
`ads_management` and be assigned to zero ad accounts. Meta gives no warning; it surfaces
much later as a `#200` at publish time with a message that never mentions assignment.

### 4. Funding, confirmed

This is the one that silently breaks everything. **An ad account with no payment method
returns HTTP 200 on every write and delivers nothing** — Meta's own words. There is no API
to attach a payment method, so this is permanently a human step, both at setup and whenever
a card fails.

Set an **account-level spend cap** on each account as a hard backstop before I get access.
It is the only limit Meta enforces on my behalf rather than on trust.

`preflight` reads `funding_source_details`, `account_status`, `disable_reason` and
`spend_cap` and refuses to arm the system if any of them is wrong.

### 5. One thing I still need from you as a human, per brand

Not a credential — the boundary of what the system is allowed to say:

- **what you sell, with proof** — product URLs, real photographs, spec sheets
- **the offer, and every claim you can substantiate.** This is the legal edge of the whole
  system. Given freedom, a language model will write "clinically proven." You are the only
  party who knows what is actually true.
- **the destination** — Meta reviews the landing page as part of the ad and enforces a match
  rule between them
- **budget ceiling and target CPA or ROAS** — the entire spend authority
- **never-show / never-say list**, and confirmation you hold rights to any spokesperson
  likeness or voice used

---

## B. Optional, and what each one unlocks

| Give me | Unlocks | Without it |
|---|---|---|
| Instagram account connected to each Page | Real IG branding on Instagram placements | Page-Backed Instagram Account works via API, but renders the handle in black and non-clickable |
| Domain verification (DNS TXT) | Website conversion campaigns | On-Meta destinations only — Instant Forms, click-to-message |
| Pixel + the 8 Aggregated Event Measurement events | Purchase/lead optimisation on-site | Traffic and engagement objectives only |
| A Google Cloud project with Vertex AI enabled | Veo 3.1 video generation, indemnified | No video generation |

Google Cloud specifically: `GOOGLE_CLOUD_PROJECT`, a service account with
`roles/aiplatform.user`, and Veo enabled in `us-central1` — it is the only region that
serves Veo, with no global endpoint and no multi-region failover.

Use the **paid Vertex AI** path, not the Gemini Developer API. The Developer API enforces a
rolling 10-minute spend cap that cannot be raised on demand, which is a hard architectural
disqualifier rather than a preference. Vertex is also the only path where Google's IP
indemnity applies, and only for GA models — `veo-3.1-generate-001` and
`veo-3.1-fast-generate-001` qualify; Lite and every preview model do not.

---

## C. What I will not ask you for, ever

Because they have no API and I will surface them as escalations instead of pretending to
handle them: attaching a payment method, verifying a domain, configuring AEM events,
accepting Custom Audience terms, the non-discrimination certification, political ad
authorisation, and appealing a disapproval. All of these are UI-bound and human-only.

---

## D. Multiple Pages, multiple brands

You said there may be several Pages. That is modelled from day one as a first-class
**Brand**: one Page, optionally one Instagram account, one ad account, one pixel, one brand
kit, one claim set, one budget envelope. Learning is per-brand — what works for one of your
Pages is a *prior* for another, never a conclusion, because audience, offer and price differ.

Brands are configured in `brands/*.yaml`, one file each. `preflight` validates every brand
independently and will happily arm three and refuse a fourth.

---

## E. Runtime modes — how I avoid spending your money by accident

Enforced in the API client itself, not in workflow code, so no future code path can bypass it:

| Mode | Generation | Meta writes | Spend |
|---|---|---|---|
| `SIMULATE` | stubbed | none — logged to the intent ledger only | none |
| `VALIDATE` | real | `validate_only` requests only | generation only |
| `STAGE` | real | real objects, always `PAUSED`, never activated | generation only |
| `LIVE` | real | real, activation permitted | full |

The client refuses to send `status: ACTIVE` in any mode but `LIVE`, and a test enumerates
every mutation call site to prove it. Default is `SIMULATE`. Nothing reaches `LIVE` without
an explicit, deliberate change plus a funded, spend-capped, preflight-passing account.

---

## F. Autonomy, as you asked for it

You asked for complete autonomy. That is what gets built. Two clarifications about what
"complete" can mean, neither of which is a hedge:

**The system will own** every recurring decision: what to generate, what to publish, what to
scale, what to pause, what to retire, and how to remediate a policy rejection. No approval
queue, no daily check-in.

**The system cannot own** the Class-C gates in §C, because Meta exposes no API for them.
When a card declines, the honest behaviour is to stop and tell you — not to keep generating
video against an account that cannot deliver.

Between those, spend moves inside a hard envelope you set once. That is not a human in the
loop; it is the difference between an autonomous system and an unbounded one. The envelope
is a number you change, not an approval you grant.
