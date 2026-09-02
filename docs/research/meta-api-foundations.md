# Meta Marketing API — Foundations & Programmatic Access
**Research dossier for a fully-autonomous Meta ads platform**
Compiled 2026-09-02. Every non-obvious claim carries a source URL. Items I could not verify are marked **UNVERIFIED**.

---

## 0. Executive answer to "how do we get write access to someone's ad account?"

There are exactly two viable production paths, and they have very different cost/latency profiles:

| Path | What you get | Gate |
|---|---|---|
| **A. Own-account automation** (you own the Business portfolio, the app, and the ad accounts) | Full `ads_management` writes with **Standard Access only** — no App Review — because every actor has a role on the app or in the Business that claimed it | Instant. Rate-limited hard until you earn Full tier. |
| **B. Third-party / multi-tenant SaaS** (clients own their ad accounts) | Client businesses grant your app assets via **Facebook Login for Business**, which mints a **Business Integration System User (BISU) token** that by default **never expires** | Requires **Business Verification** + **App Review for Advanced Access** on `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement` |

Load-bearing quote for Path A: *"If your app will be used by anyone without a Role on the app **or a role in a Business that has claimed the app**, it must first undergo App Review."* — https://developers.facebook.com/docs/app-review

Load-bearing quote for Path B access levels: *"Apps can request permissions with Advanced Access from any app user... Permissions with Standard Access, however, can only be requested from app users who have a role on the requesting app."* and *"Business Verification is required to get Advanced Access."* — https://developers.facebook.com/docs/graph-api/overview/access-levels

**Design consequence:** build the whole product on Path A for months 0–3 (your own Business portfolio, your own ad accounts, real spend, real learning), and treat Path B as a separate onboarding subsystem shipped after App Review clears. The API surface is identical; only the token-acquisition layer differs.

---

## 1. API versions and the deprecation clock

### 1.1 Current versions (as of 2026-09-02)

| API | Latest | Released |
|---|---|---|
| Graph API | **v26.0** | 2026-07-29 |
| Marketing API | **v26.0** | 2026-07-29 (shipped together with Graph v26.0) |

Graph API version table (release → expiration), verbatim from https://developers.facebook.com/docs/graph-api/changelog/ :

| Version | Released | Expires |
|---|---|---|
| v26.0 | 2026-07-29 | TBD |
| v25.0 | 2026-02-18 | 2028-07-29 |
| v24.0 | 2025-10-08 | 2028-02-18 |
| v23.0 | 2025-05-29 | 2027-10-08 |
| v22.0 | 2025-01-21 | 2027-05-20 |
| v21.0 | 2024-10-02 | 2027-01-21 |
| v20.0 | 2024-05-21 | **2026-09-24** |
| v19.0 | 2024-01-23 | 2026-05-21 (gone) |

### 1.2 THE version gotcha: Graph API versions live ~2 years, Marketing API versions live ~1 year

Graph API policy: *"A version will no longer be usable two years after the date that the subsequent version is released."* — https://developers.facebook.com/docs/graph-api/guides/versioning

Marketing API is on a **much shorter clock**. From the Marketing API changelog table (https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog):

| Marketing API version | Introduced | Availability end |
|---|---|---|
| v26.0 | 2026-07-29 | TBD |
| v25.0 | 2026-02-18 | TBD |
| v24.0 | 2025-10-08 | **2026-10-06** |
| v23.0 | 2025-05-29 | **2026-06-09** |

That is roughly **12 months**, not 24. The Marketing API versioning page states only a floor: *"When a new version of the Marketing API releases, Meta continues to support the previous version of the Marketing API for at least 90 days."* and adds *"You have at least a 90-day grace period to move over to the new version. During the 90-day grace period, you can call both the current version and the deprecated version."* — https://developers.facebook.com/docs/marketing-api/versions

> **Fact-check note (2026-09-02): Meta's own Marketing API pages disagree with each other about the current version.**
> - https://developers.facebook.com/docs/marketing-api/changelog/ **does** list **Marketing API v26.0, introduced July 29, 2026, availability TBD**, and announces *"Marketing API version auto-upgrade will be released on July 29, 2026."*
> - https://developers.facebook.com/docs/marketing-api/versions still says *"The current version of the Marketing API is v25.0"*.
> - The mirror at https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog contains **no v26.0 row at all** — its newest row is v25.0 (2026-02-18).
> There is **no standalone `/docs/marketing-api/changelog/version26.0` page** (HTTP 404); the ads changes for v26.0 live in the Graph API v26.0 changelog. Treat the changelog index as authoritative and **v26.0 as the current Marketing API version**, but do not be surprised when a Meta page contradicts it.

**Engineering rule: pin the version string in one constant, and put a calendar job on it. Assume a forced Marketing API migration every ~6 months (2 releases/year) and a hard death at ~12 months.**

### 1.3 Auto-upgrade (new-ish, and a silent-behaviour-change risk)

- Marketing API v26.0 shipped **version auto-upgrade** on 2026-07-29.
- Behaviour: *"Once a version is unavailable, any calls made to that version number may fail or be upgraded to the next available version."* Endpoints **unaffected** by inter-version changes are silently upgraded; endpoints that **did** change are not, and will fail.
- Detection header: `X-Ad-Api-Version-Warning: "The call has been auto-upgraded to vXXX as vXXX has been deprecated"` — log and alert on this header.
- It can be disabled: App Dashboard → Marketing API product card → **Settings > Ads API Version Settings**.
- Graph API equivalent: *"once a version is no longer usable, any calls made to it will be defaulted to the next oldest, usable version."*
Sources: https://developers.facebook.com/docs/marketing-api/versions , https://developers.facebook.com/docs/graph-api/guides/versioning , https://ppc.land/facebook-announces-auto-upgrade-feature-to-streamline-marketing-api-versioning/

**Never make unversioned calls.** An unversioned call uses the version configured in App Dashboard → Settings → Advanced, i.e. a value someone can change in a UI without a deploy.

### 1.4 Recent breaking changes you must already be compliant with

- **v26.0 (2026-07-29)**: `poll_spec` and poll interactive components removed from ads/creatives; Instagram **Explore Feed** placement discontinued; **Messenger Stories** silently removed from `messenger_positions`; Shop-enabled advertisers' creatives now default to `WEBSITE_AND_SHOP` destination unless you set `WEBSITE_AND_SHOP_OPT_OUT`; removal of `pretty`, `debug`, `date_format` query params and root `GET /?ids=...`. — https://developers.facebook.com/docs/graph-api/changelog/version26.0/
- **v25.0 (2026-02-18)**: creation/duplication/update of **Advantage+ shopping campaigns and Advantage+ app campaigns** blocked on `POST /{ad-account-id}/campaigns` and `POST /{campaign-id}/copies` as of **2026-05-19**; async report run objects now return `error_code` (type changed uint→int), `error_message`, `error_subcode`, `error_user_title`, `error_user_msg` by default on `GET /{ad-report-run-id}`. — https://developers.facebook.com/docs/graph-api/changelog/version25.0/
- **v22.0 lineage**: `instagram_actor_id` → **`instagram_user_id`**, `instagram_story_id` → **`instagram_media_id`** in `object_story_spec`. Marketing API migration deadline was **2026-01-21**. If any tutorial or SDK sample you copy uses `instagram_actor_id`, it is dead. — https://developers.facebook.com/docs/graph-api/changelog/version22.0/

---

## 2. App setup: app type, use cases, products

### 2.1 App type

For anything Marketing API or Login-for-Business, the app must be a **business type app**: *"Your Meta app must be a business type app."* — https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
Migrating a non-business app into Login for Business requires going back through App Review for Advanced Access.

### 2.2 Use cases (the modern App Dashboard model)

App Dashboard no longer asks you to bolt on "products" in isolation; you select **use cases**, and each use case carries a permission bundle. The three Marketing API use cases, verbatim labels:

1. **"Create & manage ads with Marketing API"**
2. **"Measure ad performance data with Marketing API"**
3. **"Capture & manage ad leads with Marketing API"**

All three bundle the same core set:
`ads_management`, `ads_read`, `business_management`, `pages_read_engagement`, `pages_show_list`, `public_profile`, plus the **"Ads Management Standard Access"** feature (now labelled *Marketing API Access Tier* — see §4).

Extra per use case:
- Leads: `leads_retrieval`, `pages_manage_ads` (docs render it as `page_manage_ads`)
- Ad creation (optional): `catalog_management`, `pages_manage_ads`, `threads_business_basic`
- Measurement: nothing extra

Source: https://developers.facebook.com/docs/development/create-an-app/marketing-api-use-cases/
Note: that page still uses the pre-May-2026 name "Ads Management Standard Access" — Meta's own docs are lagging the rename.

The Quickstart panel under the use case is also where you **create the sandbox ad account** and where dashboard-generated tokens live (dashboard-generated user tokens are described there as valid ~2 months).

### 2.3 Business portfolio linkage

App Dashboard → Settings → connect the app to a **business portfolio** (Business Manager). This is a prerequisite for Business Verification, for system users, and for the "role in a Business that has claimed the app" exemption in §0.

---

## 3. Permission matrix — what each operation actually needs

From https://developers.facebook.com/docs/permissions/ and https://developers.facebook.com/docs/permissions/reference/ads_management

| Permission | Grants | Requires App Review for Advanced Access | Documented prerequisites |
|---|---|---|---|
| `ads_management` | Read **and write** ad accounts owned or granted: *"Programmatically create campaigns, manage ads or fetch Ad metrics"* | **Yes** | `pages_read_engagement`, `pages_show_list` |
| `ads_read` | Ads Insights API + Server-Side (Conversions) API read | **Yes** | — |
| `business_management` | Business Manager API read/write: manage business assets, claim ad accounts, mint granular BISU tokens | **Yes** | `pages_read_engagement`, `pages_show_list` |
| `pages_show_list` | List of Pages the person manages | No | — |
| `pages_read_engagement` | Read Page content/followers/insights | No | `pages_show_list` |
| `pages_manage_ads` | Create/manage ads associated with a Page (incl. messaging-surface ads) | **Yes** | `pages_show_list` |
| `pages_manage_metadata` | Page webhooks + Page settings | No | `pages_show_list` |
| `instagram_basic` | Read IG Business account profile + media (needed to resolve the IG actor for IG placements) | No | `pages_read_user_content`, `pages_show_list` |
| `instagram_manage_insights` | IG account/media/story insights | No | `instagram_basic`, `pages_read_engagement`, `pages_show_list` |
| `instagram_content_publish` | Publish organic IG feed photo/video (needed only if you post organically, not for ads) | **Yes** | `instagram_basic`, `pages_read_engagement`, `pages_show_list` |
| `leads_retrieval` | Read lead-ad form submissions | **Yes** | `ads_management`, `ads_read`, `business_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list` |
| `catalog_management` | CRUD product catalogs (DPA/Advantage+ catalog ads) | **Yes** | `business_management` |
| `read_insights` | Page/app/domain insights you own | No | `pages_read_engagement`, `pages_show_list` |
| `attribution_read` | Attribution API reports | **Yes** | — |

Caveat: the "No" rows above come from a summarised read of the permissions index. In practice **every** permission has both a Standard and an Advanced tier, and the Advanced tier of any of them is unusable by non-role users until the app is connected to a verified Business. Treat "No" as "no *individual* review submission, but still gated behind Business Verification." **UNVERIFIED** at the per-permission page level for `pages_show_list` / `pages_read_engagement` / `instagram_basic`.

### 3.1 Minimum viable permission set for "create and publish a video ad on a client's account"

`ads_management` (campaign/adset/ad/creative writes + video upload to `act_X/advideos`)
+ `pages_show_list` + `pages_read_engagement` (dependency of `ads_management`; also how you resolve the `page_id` that must appear in `object_story_spec`)
+ `business_management` (to enumerate the client's ad accounts/pages, and to mint granular BISU tokens)
+ `instagram_basic` (to resolve `instagram_user_id` for IG placements)
+ `ads_read` (Insights; technically `ads_management` implies read, but the Insights BUC bucket and the review flow treat `ads_read` as its own thing)
+ `pages_manage_ads` only if you touch Page-owned ad objects / messaging ads
+ `leads_retrieval` only if you run lead-gen objectives

---

## 4. The two "access" concepts that share the same words (biggest naming trap in the platform)

There are **two independent dials** and Meta reused the words *Standard* and *Advanced* for both.

**Dial 1 — Graph platform permission access level** (per permission, set by App Review):
- *Standard Access*: the permission only works for users who **have a role on the app**. Auto-granted.
- *Advanced Access*: the permission works for **any** user. Requires **Business Verification**, sometimes an individual review.
Source: https://developers.facebook.com/docs/graph-api/overview/access-levels

**Dial 2 — "Marketing API Access Tier"** (per app, formerly the *Ads Management Standard Access* / AMSA feature). This dial controls **rate-limit quota and system-user quota only**. Renamed **2026-05-04**:

Verbatim from https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/ :
> Lower tier: "Standard Access" → Lower tier: **"Limited Access"**
> Upper tier: "Advanced Access" → Upper tier: **"Full Access"**

And verbatim from https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/ :

| Marketing API Access | Marketing API Access Tier | Capacity |
|---|---|---|
| Development access | Limited access | Basic rate limiting quota |
| Standard access | Full access | More rate limiting quota |

So the mapping you need taped to the wall:

```
App Dashboard label (old)  App Dashboard label (new)  ads_api_access_tier header value   Max score
"Standard Access" (AMSA)   "Limited Access"           development_access                 60
"Advanced Access" (AMSA)   "Full Access"              standard_access                    9000
```

The header field values (`development_access`, `standard_access`) are believed unchanged because the rename blog states *"No code changes are required."* — **UNVERIFIED** whether Meta later started emitting `limited_access`/`full_access`. **Parse this field defensively: treat any unknown string as the low tier.**

### 4.1 Qualifying for Full Access (Marketing API Access Tier)

Requirements, effective 2026-05-04 (lowered from 1,500 calls):
- *"500+ Marketing API calls in the past 15 days"*
- *"Error rate < 15% in the last 500 calls"*
- **"The screen recording upload is no longer required."**
- Upgrade action: *"Click +Upgrade for the Marketing API Access Tier feature in your App Dashboard."* Requirements are now shown inline in App Dashboard → Permissions & Features.
Sources: https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/ , https://developers.facebook.com/docs/marketing-api/access

What Full tier buys, verbatim: Limited is *"Heavily rate-limited per ad account"*, Full is *"Lightly rate limited per ad account"*; system users go **1 regular + 1 admin → 10 regular + 1 admin**; full access to all Business Manager APIs.

### 4.2 Use-it-or-lose-it

Developer Policy **10.4**, verbatim: *"Standard and Advanced Ads API access may be downgraded to Development access after 30 days of non-use."* — https://developers.facebook.com/devpolicy/ (confirmed verbatim 2026-09-02)
**Design consequence: a heartbeat job that makes real Marketing API calls at least weekly on every app, forever, including staging apps you care about.**

---

## 5. Tokens

### 5.1 Types and lifetimes

| Type | Lifetime | Use in this system |
|---|---|---|
| Short-lived user token | *"about one to two hours"* | Only inside the OAuth callback |
| Long-lived user token | *"about 60 days"* (`expires_in` ≈ 5,183,944 s) | Fallback only |
| Page access token (derived from long-lived user token) | *"Long-lived Page access tokens do not have an expiration date and only expire or are invalidated under certain conditions"* | Needed for some Page-scoped reads; **not** needed for ad creation itself |
| **System User token** (your own business) | *"does not expire, so it can be used in long-running scripts or services"*, or 60-day if you opt in | **Path A backbone** |
| **BISU token** (client business, via Login for Business) | *"Defaults to never expire for the common offline server-to-server communication"*; optional 60-day | **Path B backbone** |
| App access token (`{app-id}\|{app-secret}`) | n/a | `debug_token`, webhooks verification |

Warning quoted from the docs: *"Do not depend on these lifetimes remaining the same — they may change without warning or expire early."*
Sources: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/ , https://developers.facebook.com/docs/marketing-api/get-started/authentication/ , https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/

### 5.2 Exact endpoints

**Short-lived → long-lived user token**
```
GET https://graph.facebook.com/v26.0/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id={app-id}
  &client_secret={app-secret}
  &fb_exchange_token={short-lived-token}
→ { "access_token": "...", "token_type": "bearer", "expires_in": 5183944 }
```

**Long-lived page tokens**
```
GET https://graph.facebook.com/v26.0/{app-scoped-user-id}/accounts
  ?access_token={long-lived-user-token}
→ data[].access_token, data[].id, data[].name, data[].tasks
```
Both must run server-side (they need `client_secret`).
Source: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived

**Authorization-code exchange (Login / Login for Business)**
```
GET https://graph.facebook.com/v26.0/oauth/access_token
  ?client_id={app-id}&redirect_uri={redirect}&client_secret={app-secret}&code={code}
```

**Install your app for a system user** (prerequisite before that system user can mint a token for the app):
```
POST https://graph.facebook.com/v26.0/{SYSTEM-USER-ID}/applications
  -F business_app={APP_ID}
  -F access_token={admin or admin-system-user token}
```

**Generate a system user token**
```
POST https://graph.facebook.com/v26.0/{SYSTEM-USER-ID}/access_tokens
  -F business_app={APP_ID}
  -F scope=ads_management,ads_read,business_management,pages_show_list,pages_read_engagement,instagram_basic
  -F set_token_expires_in_60_days=true          # omit for a never-expiring token
  -F appsecret_proof={HMAC-SHA256(caller_token, app_secret)}
  -F access_token={caller token}
→ { "access_token": "EAAB..." }
```
Supported `scope` values on this endpoint (verbatim list): `ads_management, ads_read, attribution_read, business_management, catalog_management, commerce_account_manage_orders, commerce_account_read_orders, commerce_account_read_settings, instagram_basic, instagram_branded_content_ads_brand, instagram_branded_content_brand, instagram_content_publish, instagram_manage_comments, instagram_manage_insights, instagram_manage_messages, instagram_shopping_tag_products, leads_retrieval, page_events, pages_manage_ads, pages_manage_cta, pages_manage_engagement, pages_manage_instant_articles, pages_manage_metadata, pages_manage_posts, pages_messaging, pages_read_engagement, pages_read_user_content, pages_show_list, private_computation_access, publish_video, read_audience_network_insights, read_insights, read_page_mailboxes, whatsapp_business_management, whatsapp_business_messaging`

Historical trap: the endpoint used to be `/{SYSTEM-USER-ID}/ads_access_token`; that name no longer works.

**Refresh a 60-day system user token** (same `fb_exchange_token` grant, plus the flag):
```
GET https://graph.facebook.com/v26.0/oauth/access_token
  ?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}
  &set_token_expires_in_60_days=true&fb_exchange_token={current-token}
```

**Revoke**
```
GET https://graph.facebook.com/v26.0/oauth/revoke
  ?client_id={app-id}&client_secret={app-secret}
  &revoke_token={token-to-kill}&access_token={caller-token}
→ { "success": "true" }
```
All parameters must reference the same app; the app must not be throttled/disabled/deleted.
Source for all of the above: https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/

### 5.3 `appsecret_proof`

```
appsecret_proof = HMAC_SHA256(message = access_token, key = app_secret)   // hex
```
PHP reference implementation straight from the docs:
```php
$appsecret_proof = hash_hmac('sha256', $access_token, $app_secret);
```
- Enable enforcement: App Dashboard → **App Settings > Advanced > Security > Require App Secret**. When on, *"all client-initiated calls must be proxied through your backend where the appsecret_proof parameter can be added to the request"*, and calls without it **fail**.
- It is **mandatory** (not optional) on `POST /{SYSTEM-USER-ID}/access_tokens` and `POST /{CLIENT_BUSINESS_ID}/system_user_access_tokens` regardless of the Require-App-Secret toggle.
- `appsecret_time`: not documented on the securing-requests page. **UNVERIFIED** whether Meta enforces a time-bound variant.
Source: https://developers.facebook.com/docs/graph-api/securing-requests

**Build note:** add `appsecret_proof` to *every* server-side call unconditionally. It costs one HMAC and it is the difference between "token leak = attacker has full write access" and "token leak = attacker has nothing without your app secret."

### 5.4 Token introspection — `debug_token`

```
GET https://graph.facebook.com/v26.0/debug_token
  ?input_token={token-to-inspect}
  &access_token={app-access-token or developer user token}
```
Response `data` fields: `app_id`, `application`, `type`, `is_valid`, `issued_at`, `expires_at` (unixtime; `0` = never), `data_access_expires_at`, `user_id`, `profile_id`, `scopes[]`, **`granular_scopes[]`** (each `{scope, target_ids[]}`), `metadata`, `error{code,message,subcode}`.
Source: https://developers.facebook.com/docs/graph-api/reference/v26.0/debug_token

**`granular_scopes[].target_ids` is the single most useful field in the whole auth surface** — it tells you *which specific ad account / page IDs* a user actually ticked in the consent dialog. Users routinely grant `ads_management` but deselect the account you need. Check this at onboarding and re-check on every `#200`/`#294` failure instead of guessing.

Also alert on `data_access_expires_at` (the Data Access Expiration clock, independent of token expiry) — a token can be `is_valid: true` while data access has lapsed.

---

## 6. Onboarding client ad accounts (Path B in detail)

### 6.1 Facebook Login for Business → BISU tokens (the modern, correct flow)

- App must be a **business type app**.
- You do **not** pass `scope`. You create a **Configuration** in App Dashboard → *Facebook Login for Business > Configurations*, choosing: token type (User vs **Business Integration System User**), permission set, asset types the client must select, and expiration preference. You then pass `config_id`.
- BISU requires the **authorization-code** grant.

JS SDK invocation:
```js
FB.login(function (r) { /* r.authResponse.code */ }, {
  config_id: '<CONFIG_ID>',
  response_type: 'code',
  override_default_response_type: true
});
```
Redirect flow params: `config_id`, `response_type=code`, `redirect_uri`, `state` (CSRF).

Then exchange the code server-side at `GET /v26.0/oauth/access_token?client_id=…&client_secret=…&code=…`.

Identify the tenant:
```
GET /v26.0/me?fields=client_business_id&access_token={BISU_TOKEN}
→ { "client_business_id": "...", "id": "<APP_SCOPED_ID>" }
```

Mint **granular** per-tenant tokens (strongly recommended):
```
POST /v26.0/{CLIENT_BUSINESS_ID}/system_user_access_tokens
  -F access_token={BISU token, needs business_management}
  -F appsecret_proof={...}
  -F asset={comma-separated asset IDs}      # must be a subset of the original token's assets
  -F scope={comma-separated scopes}         # must be a subset
  -F fetch_only=false
  -F system_user_id={...}
  -F set_token_expires_in_60_days=false
→ { "access_token": "..." }
```
Rationale, quoted: granular tokens *"are specific to a client business portfolio, not shareable across different client businesses… This isolation ensures that only a specific client business will be impacted in the event of a compromised token, instead of impacting all business portfolios across all client businesses."*

Revocation is client-side and invisible to you: *"Business clients can invalidate business integration system user access tokens"* via **Business Settings → Integrations → Connected apps**. There is **no documented webhook** for that revocation. **You will discover it as a `#190` at 3am.**
Source: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business and https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business

**Gotcha:** *"all permissions that your app asks for during login must be granted by your app user or your app won't be granted any permissions."* Login for Business is all-or-nothing per configuration — so keep configurations minimal and create separate configurations for optional capabilities (catalog, leads) rather than one maximal config that clients will abandon.

### 6.2 Classic Business Manager asset sharing (still needed for agency/enterprise clients)

Ownership model: assets are **owned** by exactly one business, and can be **shared** to another business as a *client* relationship (`access_type` = `OWNER` | `AGENCY`).

```
GET  /v26.0/{BUSINESS_ID}/owned_ad_accounts            # accounts your business owns
GET  /v26.0/{BUSINESS_ID}/client_ad_accounts           # accounts shared TO your business
GET  /v26.0/{BUSINESS_ID}/pending_owned_ad_accounts    # requests awaiting client approval
POST /v26.0/{BUSINESS_ID}/owned_ad_accounts
     -F adaccount_id=act_{AD_ACCOUNT_ID}               # → access_status: PENDING if you're not admin
```
Returned fields include `permitted_tasks` and `access_type`.

Assign a user or **system user** to an ad account:
```
POST /v26.0/act_{AD_ACCOUNT_ID}/assigned_users
  -F user={BUSINESS_SCOPED_USER_ID or SYSTEM_USER_ID}
  -F tasks=['MANAGE','ADVERTISE','ANALYZE']
  -F access_token={...}
```
Task enum: **`MANAGE`, `ADVERTISE`, `ANALYZE`** — these three (and only these three) are the combinations the ad-accounts asset-management guide documents, as `['ANALYZE']`, `['ADVERTISE','ANALYZE']`, `['MANAGE','ADVERTISE','ANALYZE']`. **`DRAFT` was not present on that page when re-checked 2026-09-02 — treat it as UNVERIFIED and do not depend on it.** Role shorthand:
- `ANALYZE` = reporting only
- `ADVERTISE` + `ANALYZE` = general user (can create/edit ads, can't touch billing or permissions)
- `MANAGE` + `ADVERTISE` + `ANALYZE` = admin (*"manage all aspects of campaigns, reporting, billing and ad account permissions"*)
- `DRAFT` = can build but not publish

Verify from the system user's side:
```
GET /v26.0/{SYSTEM-USER-ID}/assigned_ad_accounts?fields=id,name,tasks,permitted_tasks
```
(read-only edge; POST/PUT/DELETE are rejected — you must assign from the ad-account side.)
Sources: https://developers.facebook.com/docs/marketing-api/business-asset-management/guides/ad-accounts , https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/system-user/assigned_ad_accounts

**Ordering gotcha:** the target must already be a member of the business before `assigned_users` succeeds. Sequence is: create/claim business membership → install app for system user → assign assets → mint token. Doing it out of order gives you `#100` with a message that does not say "wrong order."

### 6.3 Creating ad accounts programmatically

```
POST /v26.0/{BUSINESS_ID}/adaccount
```
Required: `name`, `currency` (ISO 4217), `timezone_id` (uint), `end_advertiser`, `media_agency`, `partner`.
The last three must each be *"a Facebook Page Alias, Facebook Page ID or a Facebook App ID"* — or the sentinel values `NONE`/`UNFOUND` where allowed. `end_advertiser` = the entity the ads target (your client), `media_agency` = you, `partner` = tech partner or `NONE`.
Optional: `invoice` (bool — only if the BM has a credit line on Meta's CRM), `po_number`, `ad_account_created_from_bm_flag`.

Error codes on this endpoint: `100` invalid parameter, **`3979` exceeded ad account limit for Business Manager**, **`3980` ad accounts in bad standing or under review**, `415` two-factor authentication required, `3902` technical issue, `457` invalid session origin, `190` invalid token, `23007` credit card incompatible with billing setup.
Source: https://developers.facebook.com/docs/marketing-api/reference/business/adaccount/

**Hard constraint: you cannot attach a payment method via the API.** Ad account creation via API is realistically limited to *"Marketing API partners who have invoicing enabled"* whose spend bills to the business's credit line (https://developers.facebook.com/docs/marketing-api/business-manager/get-started). For everyone else, the funding source is a human step in Ads Manager / Business Settings. **Bake a "client must add a payment method" step into onboarding; there is no way to automate it.**

### 6.4 Ad account health signals to poll

`GET /v26.0/act_{ID}?fields=account_status,disable_reason,funding_source_details,is_prepay_account,balance,amount_spent,spend_cap,min_daily_budget,currency,timezone_id,capabilities,business`

`account_status`: `1` ACTIVE, `2` DISABLED, `3` UNSETTLED, `7` PENDING_RISK_REVIEW, `8` PENDING_SETTLEMENT, `9` IN_GRACE_PERIOD, `100` PENDING_CLOSURE, `101` CLOSED.
`disable_reason`: 15 values incl. `1` ADS_INTEGRITY_POLICY, `2` ADS_IP_REVIEW, `6` BUSINESS_INTEGRITY_RAR.
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-account

An autonomous system must treat `account_status != 1` as a hard stop: it will otherwise burn its entire rate-limit budget getting `#2635`/`#200` on every write.

---

## 7. App Review, Business Verification, and the annual renewal

### 7.1 Business Verification

- *"Advanced Access now requires Business Verification."*
- *"Apps that request advanced access for permissions … must be connected to a Business that has completed Business Verification. Until then, app users from other Businesses will be unable to grant these apps permissions and all features will be inactive."*
- Separate from **Individual Verification** (the dashboard offers "+ Business Verification" after Individual Verification).
- Document list lives in the Business Help Center article "About Business Verification"; the developer docs do not enumerate it. Timeline not documented. **UNVERIFIED** — practitioner reports of days-to-weeks are not authoritative.
Source: https://developers.facebook.com/docs/development/release/business-verification

### 7.2 App Review submission

Dashboard flow (App Review → Permissions and Features):
1. Select permissions/features
2. Complete Business Verification
3. Answer **Data Handling Questions** (evaluated in ~30 seconds)
4. App settings: icon **1024×1024** with no Meta trademarks, privacy policy URL, app purpose, category, contact email
5. App verification / access instructions for the reviewer
6. Per-permission usage descriptions
7. Accept Platform Onboarding Terms, submit

**Hard prerequisite most teams miss:** *"Make at least 1 successful API call using each permission"* within **30 days** of submission. Meta checks telemetry. Submitting before you have exercised the permission in Standard Access is an automatic rejection.

**Screencast** (still required for the `ads_management` App Review, even though it was dropped from the *Marketing API Access Tier* upgrade in May 2026 — do not conflate them):
- show the full Facebook login **including the permission grant dialog**
- show how a business accesses ads performance data after authorization
- show metrics rendered: **Impressions, Conversions, Spend, Clicks, Reach**
- English UI or captions; ≥1080p; monitor ≤1440px wide; large visible cursor; mouse over keyboard; no audio required; don't use your personal account's credentials (reviewers use their own test accounts)

**Use case description for `ads_management`:** *"provide specific examples of why your app requires managing ads on behalf of other businesses."*

**Review time:** decisions *"within a week"* of submission per the submission guide; the newer consolidated flow promises notification *"within 10 days."*
Sources: https://developers.facebook.com/docs/app-review/submission-guide , https://developers.facebook.com/docs/permissions/reference/ads_management , https://developers.facebook.com/docs/app-review

### 7.3 Data Access Renewal (replaces Data Use Checkup / DPA / annual re-review)

Meta is consolidating: *"data access renewal consolidates most of these existing assessments into one streamlined process"* — folding together data handling questions, **Data Use Checkup**, App Review, Data Protection Assessment, and ongoing reviews. Rolling out in phases; you can be dispatched for renewal shortly after completing an individual assessment.
Sources: https://developers.facebook.com/docs/resp-plat-initiatives/data-access-renewal , https://ppc.land/meta-unveils-consolidated-data-access-renewal-process-for-developers/

Legacy Data Use Checkup semantics (still the operative model): annual certification; **60-day** window from notification; failure to complete ⇒ app loses platform features / is disabled. Advanced Access apps *"must complete annual Data Use Checkup."*
Source: https://developers.facebook.com/docs/graph-api/overview/access-levels

**Design consequence: the compliance calendar is part of the product.** An autonomous ads platform that silently loses Advanced Access mid-flight will fail every client write at once. Model it as a monitored, alerting subsystem with a named human owner.

---

## 8. Rate limits — the part that decides your architecture

### 8.1 Two systems, and which wins

Verbatim: *"If both Platform and Business Use Case rate limits can be applied to a request, BUC rate limits will be applied."*
Marketing API calls made with a **system user or page token** go through **BUC**. Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/

### 8.2 Platform (app-level)

`Calls within one hour = 200 × (number of daily active users)` — an **app-wide** pool, not per user. Header:
```
x-app-usage: {"call_count":28,"total_time":25,"total_cputime":25}
```
Each value is a **percentage 0–100**; throttling at 100 on any of the three. `total_cputime` and `total_time` are the ones that bite for Insights-heavy workloads — you can be at `call_count: 12` and `total_cputime: 98`.

### 8.3 BUC formulas (per business object, rolling 1 hour)

| Bucket | Limited tier (`development_access`) | Full tier (`standard_access`) |
|---|---|---|
| `ads_management` | `300 + 40 × active_ads` | `100000 + 40 × active_ads` |
| `ads_insights` | `600 + 400 × active_ads − 0.001 × user_errors` | `190000 + 400 × active_ads − 0.001 × user_errors` |
| `custom_audience` | `5000 + 40 × active_custom_audiences` | `190000 + 40 × active_custom_audiences` |
| `pages` (page/system-user token) | `4800 × engaged_users` per **24h** | |
| `instagram` | `4800 × impressions` per 24h | |
| `leadgen` | `4800 × leads_generated` per 24h | |
| `messenger` | `200 × engaged_users` per 24h | |
| `catalog_management` | `20000 + 20000 × log2(DA impressions + PDP visits)` per hour | |

Two things that fall out of this and shape the whole system:
1. **Quota scales with `active_ads`.** A brand-new account with zero active ads gets **300 ads_management calls/hour** on Limited tier. Your bootstrap sequence (create campaign → adset → upload video → creative → ad) is ~6–10 calls per ad; you can create maybe 30 ads/hour on a cold account before throttling. Plan the cold-start path to be call-frugal.
2. **`ads_insights` quota is reduced by your own error count** (`− 0.001 × user_errors`). Sloppy retry loops literally shrink your reporting budget.
3. **There is a hard ceiling of 700,000 calls/hour** that the `custom_audience` formulas cannot exceed regardless of how many audiences you have (verified 2026-09-02 on the Graph API rate-limiting page). Complete `type` enum for `x-business-use-case-usage`: `ads_insights`, `ads_management`, `custom_audience`, `instagram`, `leadgen`, `messenger`, `pages`.

### 8.4 The header you must parse on every response

```
x-business-use-case-usage: {
  "{business-object-id}": [{
      "type": "ads_management",              // ads_insights | custom_audience | instagram | leadgen | messenger | pages
      "call_count": 95,                       // % of hourly quota
      "total_cputime": 20,                    // %
      "total_time": 20,                       // %
      "estimated_time_to_regain_access": 0,   // MINUTES until unthrottled
      "ads_api_access_tier": "development_access"
  }]
}
```
Also:
```
x-ad-account-usage: {"acc_id_util_pct":9.67,"reset_time_duration":100,"ads_api_access_tier":"standard_access"}
x-fb-ads-insights-throttle: {"app_id_util_pct":..., "acc_id_util_pct":..., "ads_api_access_tier":"standard_access"}
```
`reset_time_duration` is **seconds**; `estimated_time_to_regain_access` is **minutes**. Mixing those units is a classic outage.
Sources: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ , https://developers.facebook.com/docs/marketing-api/insights/best-practices/

### 8.5 The *other*, undocumented-in-headers limiter: the ad-account point score

Separate from BUC, Marketing API applies a per-ad-account **point score**:
- **read = 1 point, write = 3 points**
- Limited tier: **max score 60**, decay **300 s**, block **300 s**
- Full tier: **max score 9000**, decay **300 s**, block **60 s**
- Real-time mutation ceiling: **100 QPS per (app, ad account) pair** on create/edit of campaigns, ad sets, ads
Source: https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/

**Do the arithmetic:** on Limited tier, 60 points ÷ 3 points/write = **20 writes per 300-second window per ad account**. That is 4 writes/minute. This — not the BUC hourly number — is what actually stops your bulk creative launcher during development.

### 8.6 Hard per-object edit limits (these are not rate limits, they are policy)

- **Ad set budget: 4 changes per hour.** Error `#613` subcode **1487632**: *"You can only change your ad set budget 4 times per hour. Please wait to make more changes."*
- **Ad account spend limit: 10 changes per day.** The error for breaching this is **`#17` subcode `1885172`**, *not* `#613` — a different code family from the ad-set-budget limit, so branch on both. (Verified 2026-09-02 against https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/)
- `#613` subcode **1487742**: *"There have been too many calls from this ad-account. Please wait a bit and try again."*
Source: https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/

**This kills the naive autonomous-optimizer design.** A closed loop that nudges budgets every 5 minutes will be throttled within 20 minutes and will then be unable to make the *one* change that mattered. Budget changes must be batched into a scheduler with ≤4 writes/hour/ad set, with a priority queue so the highest-value change wins the slot.

### 8.7 Object-count ceilings

Ad accounts cap out around **5,000 campaigns / 5,000 ad sets / 5,000 ads** (delivery-relevant objects; error **#1487809** "Campaign, Ad Set and Ad Limits Per Ad Account"). Meta's Business Help Center article is https://www.facebook.com/business/help/652738434773716 — I could not extract the numeric table from it (the page renders behind JS). The 5,000/5,000/5,000 figure is **verified-secondary only** (AdEspresso, Bïrch support docs). Additionally, *"Ad creation is limited for a given ad account based on the daily spend limit"* — higher spend unlocks more ad creation. **UNVERIFIED** exact tiers.

A system that generates creative autonomously will hit these ceilings in months. **Design an archival/GC job from day one** (`ARCHIVED` status frees the slot; `DELETED` does too).

### 8.8 Staying under the limits — concrete tactics

1. **Token-bucket per (ad_account_id, buc_type)** seeded from the last observed header, not from a static config. Refill using `estimated_time_to_regain_access`.
2. **Circuit-break at 90%** of `call_count`, `total_cputime`, or `total_time` — whichever trips first.
3. **Never retry a throttle immediately.** On `#4/#17/#80004/#80000/#613`, sleep `max(estimated_time_to_regain_access × 60, exponential_backoff)`.
4. **Do reporting with async jobs, not synchronous paged reads** (§9.2).
5. **Serialize writes per ad account**; parallelize across ad accounts. The point score is per-account.
6. **Separate the read fleet from the write fleet** so a reporting storm cannot starve publishing.
7. Get to **Full tier fast** — 500 calls / 15 days is trivially achievable with sandbox + own-account traffic, and it is worth 150× the ads_management quota.

---

## 9. Batch, async, and error handling

### 9.1 Batch requests

```
POST https://graph.facebook.com/v26.0/
  ?access_token={token}
  &batch=[{"method":"POST","name":"create-campaign","relative_url":"act_123/campaigns",
           "body":"name=X&objective=OUTCOME_SALES&status=PAUSED&special_ad_categories=[]"},
          {"method":"POST","relative_url":"act_123/adsets",
           "body":"campaign_id={result=create-campaign:$.id}&..."}]
  &include_headers=false
```
- **Max 50 operations per batch.**
- Responses come back as an array **in request order**; each element is `{code, headers, body}` where `body` is a **JSON-encoded string**, not an object. You must double-parse.
- Cross-references use JSONPath against a `name`d earlier op: `{result=op-name:$.data.*.id}`.
- `include_headers=false` materially shrinks responses — but it also strips the per-op rate headers, so keep it `true` on the batch call itself if you rely on header-based throttling. (The top-level HTTP response still carries `x-business-use-case-usage`.)
- **A batch of 10 costs 10 calls.** *"Each call counts individually toward API rate limits… no bundling discount applies."* Batching saves round-trips and latency, not quota.
- Partial timeout is real: *"Large batches may timeout partially, returning `null` for incomplete requests while successful ones show 200."* **A `null` element is not a failure — it is an unknown.** Treat it as "must re-query before retrying," or you will create duplicate campaigns.
Source: https://developers.facebook.com/docs/graph-api/batch-requests

### 9.2 Async ad-creation request sets (the right tool for bulk publishing)

```
POST /v26.0/act_{AD_ACCOUNT_ID}/asyncadrequestsets
  name, notification_uri, notification_mode=ON_COMPLETE|OFF, adbatch=[...]
GET  /v26.0/{REQUEST_SET_ID}?fields=name,total_count,success_count,error_count,is_completed
GET  /v26.0/{REQUEST_SET_ID}/requests?fields=id,status,result
GET  /v26.0/act_{AD_ACCOUNT_ID}/asyncadrequestsets
GET  /v26.0/{AD_SET_ID}/asyncadrequests
POST /v26.0/{REQUEST_SET_ID}   # update name / notification_uri / notification_mode
DELETE /v26.0/{REQUEST_ID}     # cancel one (only if unprocessed)
DELETE /v26.0/{REQUEST_SET_ID} # cancel the set
```
Per-request `status`: `initial`, `in_progress`, `success`, `error`, `canceled`. `result` holds the created object id, or the error code/message.
Note `total_count` / `success_count` / `error_count` are **non-default fields** — you must request them explicitly or you get nothing useful back.
Documented limits: 50 requests per batched request; **≤10 ads per batch for ad creation**; up to 1,000 requests per Batch API call.
Source: https://developers.facebook.com/docs/marketing-api/asyncrequests

### 9.3 Async Insights jobs

```
POST /v26.0/{AD_OBJECT}/insights           → { "report_run_id": "..." }   (an AdReportRun object)
GET  /v26.0/{AD_REPORT_RUN_ID}             → async_status, async_percent_completion,
                                              error_code, error_message, error_subcode,
                                              error_user_title, error_user_msg   (v25.0+, default fields)
GET  /v26.0/{AD_REPORT_RUN_ID}/insights    → the rows
```
`async_status` ∈ `Job Not Started`, `Job Started`, `Job Running`, `Job Completed`, `Job Failed`, `Job Skipped`.
*"Poll this field until async_status is Job Completed and async_percent_completion is 100."* Note: **100% does not imply success** — `Job Failed` can also report 100. Check both.
*"Do not store the report_run_id for long term use, it expires after 30 days."*
Data-per-call ceiling → `error_code = 100, subcode 1487534` — shrink the date range or drop to a lower object level.
Reach-with-breakdowns older than 13 months: **max 10 async requests per ad account per day**.
Sources: https://developers.facebook.com/docs/marketing-api/insights/best-practices/ , https://developers.facebook.com/docs/graph-api/changelog/version25.0/

### 9.4 Error taxonomy — retry semantics

Governing rule from the docs: *"Error handling should be done using only the Error Codes. The Description string is subject to change without prior notice."* Use `error_subcode` for branching and `blame_field_specs` to identify the offending field.

| Code | Sub | Meaning | Class | Action |
|---|---|---|---|---|
| `1` | — | Unknown / possible transient. Often a bad `level` param on Insights | Ambiguous | Retry **once** with jitter, then treat as permanent and log the request |
| `2` | — | Temporary service issue | **Transient** | Exponential backoff, retry |
| `4` | — | App-level request limit (Platform) | **Throttle** | Back off app-wide, not just this account |
| `17` | `2446079` | User request limit (Ads API v3.3 and older) | **Throttle** | Back off per-user/per-token |
| `17` | — | User request limit | **Throttle** | Back off |
| `32` | — | Page-level limit (user/app token) | **Throttle** | Back off |
| `100` | — | Invalid parameter | **Permanent** | Never retry; inspect `blame_field_specs` |
| `100` | `33` | Token lacks system-user permission on this object in BM | **Permanent** | Re-run asset assignment |
| `100` | `1487534` | Insights: too much data per call | **Permanent-ish** | Narrow date range / lower level, then retry |
| `100` | `1487694` | Deprecated targeting category | **Permanent** | Fix targeting spec |
| `190` | — | Invalid OAuth token | **Permanent** | Re-auth. Do NOT retry |
| `190` | `458` | User has not authorized the app | Permanent | Re-onboard |
| `190` | `459` | User checkpointed (`error_data` has the URL) | Permanent | Surface to human |
| `190` | `460` | Session mismatch / password changed | Permanent | Re-auth |
| `190` | `463` | Session expired | Permanent | Refresh/re-auth |
| `190` | `467` | User logged out / token invalidated | Permanent | Re-auth |
| `190` | `492` | Wrong role on the associated Page | Permanent | Fix Page role |
| `200` | — | Permission error | **Permanent** | Check `granular_scopes` |
| `200` | `1870034` | Custom Audience terms not accepted | Permanent | Human must accept ToS in Ads Manager |
| `294` | — | Requires `ads_management` permission | Permanent | App Review / re-consent |
| `368` | `1390008` | *"It looks like you were misusing this feature by going too fast"* — integrity block on the actor/Page | **Semi-permanent** | STOP all activity on that actor for hours. Do not retry. Escalate |
| `613` | `1487742` | Too many calls from this ad account | **Throttle** | Back off per ad account |
| `613` | `1487632` | Ad set budget changed >4×/hour | **Policy** | Do not retry within the hour |
| `613` | `1996` | Inconsistent API request volume detected | **Throttle** | Smooth traffic; bursts trigger this |
| `80000` | `2446079` | BUC throttle: **ads_insights** | **Throttle** | Use `estimated_time_to_regain_access` |
| `80004` | `2446079` | BUC throttle: **ads_management** | **Throttle** | Use `estimated_time_to_regain_access` |
| `80003` | `2446079` | BUC throttle: custom_audience | Throttle | Back off |
| `80001` | — | BUC throttle: pages (page/system-user token) | Throttle | Back off |
| `1487809` | — | Campaign/ad set/ad count limit per ad account | **Permanent** | Archive old objects |
| `3979` | — | Exceeded ad account limit for the Business Manager | Permanent | Request more from Meta |
| `3980` | — | Ad accounts in bad standing / under review | Permanent | Human intervention |
| `2635` | — | Deprecated API / object no longer supported | Permanent | Migrate |

Sources: https://developers.facebook.com/docs/marketing-api/error-reference , https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ , https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/ , https://developers.facebook.com/docs/marketing-api/reference/business/adaccount/

**Idempotency:** the Marketing API has **no idempotency key**. Any retry of a `POST /campaigns`, `/adsets`, `/ads`, or `/adcreatives` risks a duplicate object. Mitigations: (a) put a deterministic UUID in the object `name` and search before retrying; (b) use `POST /act_X/ads?...` with a client-side dedupe table keyed on your own request hash; (c) prefer async request sets, whose `status`/`result` per request is queryable after a network failure.

### 9.5 Webhooks worth subscribing to (Application object)

- **`ad_account`** — AdAccount status changes; payload carries account status, **disable reason**, business ID. This is how you learn a client got shut down without polling.
- **`ads_rules_engine`** — rule evaluations; `rule_id`, `account_id`, `object_id`, `object_type` ∈ `CAMPAIGN|ADSET|AD`.
- **`async_requests`** — async job completion (`complete` / `fail` + `report_id`). Removes the need to poll Insights jobs.
- `dev_alerts` — developer notifications (deprecations, review outcomes).
Source: https://developers.facebook.com/docs/graph-api/webhooks/reference/application

---

## 10. Developing without spending money

### 10.1 Sandbox ad accounts — real, but narrow

- Created in App Dashboard → **Marketing API > Tools** (or the use-case Quickstart panel).
- *"Facebook does not deliver any ads created in this sandbox mode and you will not accumulate impressions or spend."*
- *"You do not need to setup a funding source"* — no payment method required.
- *"You can create only one Sandbox ad account regardless of the access tier that your app is in."* One per app.
- *"Your Sandbox ad account is virtually the same as your production ad account in terms of functionality"* — all Marketing API endpoints callable, including any you're allowlisted for.
- **Not visible in Ads Manager or Power Editor.** API-only. You cannot eyeball your ad.
- **Insights are effectively unusable**: the sandbox does not run delivery, so *"Insights API is unsupported since changes in the sandbox environment do not go live."* The 2016 promise of "simulated insights data" was never fully delivered.
- Link it to a Page you manage; tokens via user token or a BM system user.
Sources: https://developers.facebook.com/ads/blog/post/v2/2016/10/19/sandbox-ad-accounts/ , https://developers.facebook.com/blog/post/2023/06/21/marketing-api-sandbox-capability-now-re-enabled/

**Design consequence:** the sandbox validates **request shape and permissions**, nothing about **performance**. Your optimization loop cannot be tested there. You need a real, funded, low-budget ad account (a €1–5/day "canary" account) as a second test environment.

### 10.2 Creating in PAUSED state

`status` on campaign/ad set/ad creation accepts only `ACTIVE` and `PAUSED` at creation time (`DELETED` and `ARCHIVED` are update-only). **Creating the entire tree as `PAUSED` is safe and spends nothing.** Nothing delivers until the whole ancestry is `ACTIVE` — check `effective_status`, not `status`, because a `PAUSED` parent silently disables an `ACTIVE` child.
Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group

`special_ad_categories` is **required** on `POST /act_X/campaigns`. Send `[]` or `["NONE"]` when not applicable: *"Businesses using the Marketing API must identify whether or not new and edited campaigns belong to a Special Ad Category… must indicate NONE or send an empty array in the special_ad_categories field."* Omitting it is a hard `#100`.

ODAX objective enum: `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_APP_PROMOTION`, `OUTCOME_SALES`. Legacy values (`CONVERSIONS`, `LINK_CLICKS`, `BRAND_AWARENESS`, `APP_INSTALLS`, …) may still parse on some paths but should be treated as dead for new builds.

### 10.3 A safe development ladder

1. **Sandbox account** — shape/permission validation, unlimited iteration, zero risk.
2. **Real account, everything `PAUSED`** — validates creative upload, video processing, ad review acceptance, previews (`GET /act_X/generatepreviews`), and policy checks. Zero spend.
3. **Real account, `ACTIVE`, `spend_cap` set on the account and `daily_budget` at floor** — set `spend_cap` on the ad account as a hard circuit breaker, and remember the **10 spend-cap changes/day** limit.
4. Only then, the autonomous loop.

---

## 11. Platform Terms for a third-party ads tool

From https://developers.facebook.com/devpolicy/ (section 10, "Ads"):

- **10.1** Comply with Meta Advertising Standards.
- **10.2** No third-party ads in posts, comments, notifications, requests, invites or messages.
- **10.3** Don't pair Social Plugins or Login with non-Meta ads.
- **10.4** Verbatim: *"Standard and Advanced Ads API access may be downgraded to Development access after 30 days of non-use."* (The earlier paraphrase in §4.2 said "revert to Development status following 30 days without activity" — same meaning, but this is the actual text.)
- **10.5** Verbatim: *"Don't combine multiple end advertisers or their Meta business assets in the same ad account, unless you meet the requirements described [here] or as otherwise approved by Meta in writing."*
- **10.6 (Transparency, effective 2027-02-03)** On advertiser request you must disclose: the amount spent on Meta **separate from your fees**, your fee structure, campaign configuration, and post-campaign reporting **using Meta's own terminology**. **10.6(b)**: *"Display Meta ad campaign reporting separately from other publishers."*
- **10.7(a)** *"Don't use Meta advertising data for any purpose, except on an aggregate and anonymous basis (unless the terms for that product allow it explicitly) and only to assess the performance and effectiveness of the end advertiser's campaigns."*
- **10.7(b)** *"Only use data from an end-advertiser's campaign to optimize or measure the performance of that end-advertiser's Meta campaign."* — **added by fact-check; this is stricter than 10.7(a) alone and is the clause that actually bites a cross-tenant learning loop.**
- **10.7(c)** *"Don't use data to retarget on or off of Meta."*
- **10.7(d)** *"Don't mix data obtained from us with advertising campaigns on different platforms (unless the terms for that product allow it explicitly)."*
- **10.7(e)** *"Don't use Meta's data to build or augment any user profiles."*
- **10.7(f)** *"Only allow the end advertiser or people acting on their behalf to access Meta's Platform data."* — **added by fact-check.**
- **10.7(g)** *"Keep Meta's data that you maintain on behalf of one advertiser separately from that of other advertisers."* — **added by fact-check; this is a hard data-architecture requirement (per-tenant storage isolation), not a policy nicety.**
- **10.8** You must ensure your clients accept Meta's Terms of Service, Advertising Standards, Commercial Terms and Self-Serve Ads Terms.

**10.5 compliance path** (per PPC Land's reading of Meta's guidance): either keep **one ad account per end advertiser**, or implement a `vendor_id` and/or `brand` field in your Product Catalog data **and/or** in your Meta Pixel / Conversions API events. Developers implementing those fields correctly are considered compliant with 10.5. — https://ppc.land/meta-forces-ad-spend-disclosure-to-advertisers-starting-february-2027/ (**verified-secondary**; I could not locate the primary Meta doc that 10.5 links to.)

**Design consequences, all load-bearing:**
- **One ad account per client tenant.** Not per campaign, not shared. This is both the 10.5 default and the only sane rate-limit isolation model (the point score and BUC quota are per ad account).
- Build **spend-vs-fee reporting** into the data model **now** — 10.6 lands 2027-02-03 and requires you to show Meta spend separately from your markup, in Meta's vocabulary. Retrofitting this into a fee model is expensive.
- **Never mix Meta ads data into a cross-platform user profile or a retargeting graph.** Aggregate + anonymous + this-campaign-only. This constrains what your "self-improvement" loop may learn from and store: campaign-level performance aggregates are fine; person-level Meta data is not.
- Cross-client learning ("what worked for client A informs client B") is **harder to justify than §10.7(a) alone suggests**. 10.7(b) — *"Only use data from an end-advertiser's campaign to optimize or measure the performance of that end-advertiser's Meta campaign"* — reads as a per-advertiser purpose limitation, and 10.7(g) requires you to *"keep Meta's data that you maintain on behalf of one advertiser separately from that of other advertisers."* Taken together, a model trained on tenant A's Meta performance data and then used to optimise tenant B's campaigns is **presumptively non-compliant**. Get legal review before shipping one; the safe design is per-tenant models plus non-Meta-derived priors.
- **Storage design consequence of 10.7(g):** per-tenant logical separation of all Meta-derived data (separate schemas/keys/encryption contexts), not just a `tenant_id` column on a shared table you also train across.

Additional non-negotiable: **Advertising Standards apply to every generated creative.** An AI creative pipeline that publishes without a policy pre-check will accumulate ad rejections, and repeated rejections escalate to account-level integrity blocks (`disable_reason = 1 ADS_INTEGRITY_POLICY`) — which is unrecoverable by API.

---

## 12. Gotchas (the day-costing list)

1. **Marketing API versions die in ~12 months, Graph API in 24.** Everyone plans for 24 and gets caught. v24.0 Marketing dies 2026-10-06.
2. **Auto-upgrade silently changes behaviour.** Endpoints unaffected by a version bump get upgraded; affected ones fail. Alert on `X-Ad-Api-Version-Warning` or you will debug a behaviour change that has no corresponding deploy.
3. **"Standard/Advanced" means two different things.** Permission access level (App Review) ≠ Marketing API Access Tier (rate quota). And the tier was renamed to Limited/Full on 2026-05-04 while the header still says `development_access`/`standard_access`.
4. **The screencast requirement was dropped for the *tier* upgrade, not for the `ads_management` App Review.** Conflating these wastes a review cycle.
5. **You must have made ≥1 successful call with each permission in the 30 days before submitting App Review.** Submitting a permission you have never exercised is an auto-reject.
6. **30 days of inactivity reverts your ad API access to Development.** Heartbeat job, forever.
7. **`special_ad_categories` is required on every campaign create.** Not optional, not defaulted.
8. **`instagram_actor_id` is dead** — use `instagram_user_id` (and `instagram_media_id`). Most tutorials and half the SDK samples are stale.
9. **Ad set budget: 4 changes/hour, hard.** `#613/1487632`. Your optimizer must queue and prioritise budget writes.
10. **Ad account spend limit: 10 changes/day.**
11. **On Limited tier the real ceiling is 20 writes per 5 minutes per ad account** (60-point cap, 3 points/write), not the BUC hourly number.
12. **`estimated_time_to_regain_access` is minutes; `reset_time_duration` is seconds.**
13. **Batch responses nest the body as a JSON *string*** and can contain `null` for timed-out ops. `null` ≠ failure; re-query before retrying or you create duplicates.
14. **No idempotency keys anywhere in the Marketing API.** Every write retry is a potential duplicate campaign spending real money.
15. **`total_cputime`/`total_time` throttle you at `call_count: 12`.** Insights queries with many breakdowns are CPU-expensive; call count alone is a useless budget metric.
16. **Insights quota is reduced by your own error rate** (`−0.001 × user_errors`).
17. **Sandbox has no Insights and is invisible in Ads Manager.** You cannot test the optimization loop there, and you cannot visually QA a creative.
18. **One sandbox ad account per app, regardless of tier.**
19. **You cannot add a payment method via API.** Ad account creation via API is realistically for invoiced partners only. Onboarding needs a human step.
20. **`assigned_users` fails unless the target is already a business member**, and the system user must have the app installed *before* it can mint a token for that app.
21. **Login for Business is all-or-nothing**: if the client declines any requested permission, you get **none**. Keep configurations minimal.
22. **Clients can revoke BISU tokens from Business Settings → Integrations → Connected apps, with no webhook to tell you.** Detect via `#190` and via periodic `debug_token`.
23. **`granular_scopes[].target_ids` reveals partial grants.** A client can grant `ads_management` while deselecting the ad account you need — the token looks perfect and every write returns `#200`.
24. **Error `#368/1390008` is an integrity block, not a rate limit.** Retrying makes it worse. Stop all activity on that actor.
25. **`effective_status` ≠ `status`.** A PAUSED parent silently disables an ACTIVE child; also `WITH_ISSUES`, `PENDING_REVIEW`, `DISAPPROVED` only ever show in `effective_status`.
26. **Ad account object ceilings (~5,000 each) are reachable by a generative system in months.** Build GC/archival now.
27. **Advantage+ shopping and Advantage+ app campaign creation was blocked as of 2026-05-19** — any design assuming those specific campaign types is already invalid.
28. **Data Access Renewal / Data Use Checkup will disable your app if missed** (60-day window from notification). It is a product risk, not an ops chore.

---

## 13. Open questions / unverified

1. **Exact ad-account object ceilings.** 5,000 campaigns / 5,000 ad sets / 5,000 ads is *verified-secondary only*; Meta's own help-center page (`/business/help/652738434773716`, error #1487809) would not render for extraction. Also unverified: the documented statement that *"ad creation is limited for a given ad account based on the daily spend limit"* — the exact spend→ad-count tiers are undocumented.
2. **Whether `ads_api_access_tier` now emits `limited_access`/`full_access`.** The rename blog says "no code changes are required," which implies the header values are unchanged, but I found no post-rename doc that states the emitted strings. Parse defensively.
3. **Business Verification turnaround time.** Not documented anywhere official.
4. **Whether `pages_show_list`, `pages_read_engagement`, `instagram_basic` truly need no individual App Review submission** for Advanced Access, or only no *screencast*. The permissions index summary says "No"; the access-levels doc says Advanced Access always needs Business Verification. Confirm on each permission's own reference page before planning the submission.
5. **`appsecret_time`** — whether Meta enforces a timestamped variant of `appsecret_proof`. Not mentioned in the securing-requests doc.
6. **Primary source for Developer Policy 10.5's "requirements described"** (the `vendor_id`/`brand` compliance path). Found only via secondary reporting; the Meta doc it links to was not locatable.
7. ~~**Marketing API v26.0 changelog contents.** … the Marketing API changelog index still lists only up to v25.0 in its table.~~ **RESOLVED by fact-check 2026-09-02.** The changelog index at https://developers.facebook.com/docs/marketing-api/changelog/ **does** list **Marketing API v26.0, introduced 2026-07-29, availability TBD**, and announces auto-upgrade for the same date. There is genuinely **no** standalone `/docs/marketing-api/changelog/version26.0` page (404) — the v26.0 ads changes are documented in the Graph API v26.0 changelog. Two other Meta pages are stale and still say v25.0 (see the note in §1.2).
8. **Formal per-app cap on the number of client businesses** connectable via Login for Business, and whether the "10 system users on Full tier" limit constrains BISU tenants (BISUs appear to be per-client-business, not counted against your own business's system user quota, but this is **inferred**).
9. ~~**`custom_audience` BUC formula**~~ **RESOLVED by fact-check 2026-09-02:** Limited `5000 + 40 × active_custom_audiences`, Full `190000 + 40 × active_custom_audiences`, both capped at **700,000 calls/hour**. Recorded in §8.3.
10. **Whether the sandbox now returns simulated Insights.** The 2016 blog promised it "in future releases"; the 2023 re-enable blog says Insights is unsupported. Assume unsupported.
11. **Rate-limit behaviour of async ad request sets** — whether each contained request draws a point against the ad-account score, or the set is charged once. Not documented. Assume per-request.

---

## 14. Source index

**Official Meta documentation**
- Graph API changelog / versions — https://developers.facebook.com/docs/graph-api/changelog/
- Graph API versioning policy — https://developers.facebook.com/docs/graph-api/guides/versioning
- Graph API v26.0 changelog — https://developers.facebook.com/docs/graph-api/changelog/version26.0/
- Graph API v25.0 changelog — https://developers.facebook.com/docs/graph-api/changelog/version25.0/
- Graph API v22.0 changelog (instagram_user_id migration) — https://developers.facebook.com/docs/graph-api/changelog/version22.0/
- Marketing API changelog — https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog
- Marketing API versions / auto-upgrade — https://developers.facebook.com/docs/marketing-api/versions
- Marketing API get started — https://developers.facebook.com/docs/marketing-api/get-started
- Marketing API authorization — https://developers.facebook.com/docs/marketing-api/overview/authorization
- Marketing API authentication — https://developers.facebook.com/docs/marketing-api/get-started/authentication/
- Marketing API access tiers — https://developers.facebook.com/docs/marketing-api/access
- Marketing API rate limiting — https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/
- Graph API rate limiting (BUC headers/formulas) — https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- Insights limits & best practices — https://developers.facebook.com/docs/marketing-api/insights/best-practices/
- Marketing API error reference — https://developers.facebook.com/docs/marketing-api/error-reference
- Batch requests — https://developers.facebook.com/docs/graph-api/batch-requests
- Async ad request sets — https://developers.facebook.com/docs/marketing-api/asyncrequests
- Campaign reference (special_ad_categories, objectives, status) — https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group
- AdAccount reference (account_status, disable_reason) — https://developers.facebook.com/docs/marketing-api/reference/ad-account
- POST /{business-id}/adaccount — https://developers.facebook.com/docs/marketing-api/reference/business/adaccount/
- Business asset management — ad accounts — https://developers.facebook.com/docs/marketing-api/business-asset-management/guides/ad-accounts
- System user assigned_ad_accounts — https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/system-user/assigned_ad_accounts
- System users: install apps, generate/refresh/revoke tokens — https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/
- System users overview — https://developers.facebook.com/docs/marketing-api/system-users/overview
- Access token guide — https://developers.facebook.com/docs/facebook-login/guides/access-tokens/
- Long-lived tokens — https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- debug_token — https://developers.facebook.com/docs/graph-api/reference/v26.0/debug_token
- Securing requests / appsecret_proof — https://developers.facebook.com/docs/graph-api/securing-requests
- Facebook Login for Business — https://developers.facebook.com/docs/facebook-login/facebook-login-for-business and https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business
- Permissions reference — https://developers.facebook.com/docs/permissions/ ; ads_management — https://developers.facebook.com/docs/permissions/reference/ads_management
- Access levels (Standard vs Advanced) — https://developers.facebook.com/docs/graph-api/overview/access-levels
- App Review — https://developers.facebook.com/docs/app-review ; submission guide — https://developers.facebook.com/docs/app-review/submission-guide
- Business Verification — https://developers.facebook.com/docs/development/release/business-verification
- Data Access Renewal — https://developers.facebook.com/docs/resp-plat-initiatives/data-access-renewal
- Marketing API use cases (app creation) — https://developers.facebook.com/docs/development/create-an-app/marketing-api-use-cases/
- Application webhooks reference — https://developers.facebook.com/docs/graph-api/webhooks/reference/application
- Sandbox ad accounts (2016) — https://developers.facebook.com/ads/blog/post/v2/2016/10/19/sandbox-ad-accounts/
- Sandbox re-enabled (2023) — https://developers.facebook.com/blog/post/2023/06/21/marketing-api-sandbox-capability-now-re-enabled/
- Developer Policies — https://developers.facebook.com/devpolicy/
- Marketing API Access Tier rename blog (2026-05-04) — https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/

**Secondary (used only where marked)**
- https://ppc.land/facebook-announces-auto-upgrade-feature-to-streamline-marketing-api-versioning/
- https://ppc.land/meta-unveils-consolidated-data-access-renewal-process-for-developers/
- https://ppc.land/meta-forces-ad-spend-disclosure-to-advertisers-starting-february-2027/
- https://support.adespresso.com/hc/en-us/articles/360003416933 (ad account object ceilings)


---

## Fact-check log

Adversarial re-verification run **2026-09-02** against primary Meta documentation only (`developers.facebook.com/docs`, `developers.meta.com/blog`). Every claim below was re-fetched from the cited page on that date; nothing here was accepted on the strength of a blog, a Stack Overflow answer, or plausibility.

### Verdicts

| # | Claim | Verdict | Notes |
|---|---|---|---|
| 1 | Graph API + Marketing API latest = v26.0, released 2026-07-29; full Graph version/expiry table | **CONFIRMED** | Graph table matches the published table row-for-row, incl. v20.0 expiring **2026-09-24** and v22.0 expiring **2027-05-20**. Marketing v26.0 (2026-07-29) + auto-upgrade confirmed on the Marketing API changelog index. **Caveat added to §1.2:** two other Meta pages still say v25.0. |
| 2 | Marketing API versions live ~12 months vs Graph API's 24 | **CONFIRMED** | Marketing: v24.0 2025-10-08 → **2026-10-06**; v23.0 2025-05-29 → **2026-06-09**. Graph: *"Each version is guaranteed to operate for at least two years"* / *"two years after the date that the subsequent version is released."* 90-day floor quote confirmed verbatim. |
| 3 | Standard Access suffices for own-account automation (Path A) | **CONFIRMED** | Verbatim on https://developers.facebook.com/docs/app-review : *"If your app will be used by anyone without a Role on the app or a role in a Business that has claimed the app, it must first undergo App Review."* Converse also present: *"If your app will only be used by app users who have a role on the app itself, App Review is not required."* |
| 4 | Login for Business + BISU; `config_id` not `scope`; `response_type=code`; `override_default_response_type=true`; `/me?fields=client_business_id`; `POST /{CLIENT_BUSINESS_ID}/system_user_access_tokens`; token defaults to never expire | **CONFIRMED** | All parameters confirmed, incl. `appsecret_proof` + `access_token` **required** and `asset`/`scope`/`system_user_id`/`fetch_only`/`set_token_expires_in_60_days` **optional**. Verbatim: *"defaults to never expire for the common offline server-to-server communication."* Docs render the code-exchange example at `v25.0`, not `v26.0` — cosmetic. |
| 5 | 4-step system-user provisioning sequence and exact endpoints | **CONFIRMED** | `POST /{SYSTEM-USER-ID}/applications` (`business_app`, `access_token`); `POST /{SYSTEM-USER-ID}/access_tokens` (`business_app`, `scope`, `appsecret_proof`, `access_token` required; `set_token_expires_in_60_days` optional); refresh via `GET /oauth/access_token`; revoke via `GET /oauth/revoke`. Verbatim: *"The endpoint was previously named `/SYSTEM-USER-ID/ads_access_token`. A call to that name no longer works."* Asset-assignment step confirmed separately (see row for §6.2 below). |
| 6 | `appsecret_proof` = HMAC-SHA256(access_token, app_secret); mandatory on token-minting endpoints | **CONFIRMED** | Verbatim: *"The app secret proof is a sha256 hash of your access token, using your app secret as the key."* PHP sample `hash_hmac('sha256', $access_token, $app_secret)` matches. `appsecret_time` still **not mentioned** — remains genuinely unverified. |
| 7 | BUC wins over Platform; BUC formulas; header fields | **CONFIRMED** | *"If both Platform and Business Use Case rate limits can be applied to a request, BUC rate limits will be applied."* `ads_management` 300/100000 + 40×active_ads; `ads_insights` 600/190000 + 400×active_ads − 0.001×user_errors. `estimated_time_to_regain_access` = **minutes**; `ads_api_access_tier` ∈ `development_access` \| `standard_access` — **the header values are still the old strings post-rename**, which retires most of open question #2. |
| 8 | Ad-account point score: read 1 / write 3; 60/9000 max; 300 s decay; 300 s / 60 s block; 100 QPS | **CONFIRMED** | All five numbers verbatim on the Marketing API rate-limiting page, incl. *"Limit: 100 requests per second (QPS) per app and ad account combination"*. The "20 writes per 5 minutes on Limited tier" is correct arithmetic (60 ÷ 3). |
| 9 | Ad-set budget 4 changes/hour (#613/1487632); spend limit 10/day | **CONFIRMED, with one correction** | Budget limit and both `#613` subcodes confirmed. **Correction applied:** the spend-limit-change breach surfaces as **`#17` subcode `1885172`**, not `#613`. §8.6 updated. |
| 10 | Tier renamed 2026-05-04; 500 calls/15 days; error rate <15%; screencast dropped; 10+1 system users | **CONFIRMED** | Blog verbatim on rename, effective date, both thresholds, *"the screen recording upload is no longer required"* and *"No code changes are required. The underlying permission identifier remains the same."* `/docs/marketing-api/access` independently confirms *"Can create 10 system users and 1 admin system user"* and *"Lightly rate limited per ad account"*. |
| 11 | `ads_management` App Review still needs a screencast + 1 prior successful call per permission | **CONFIRMED** | Verbatim: *"Make at least 1 successful API call using each permission for which you are requesting advanced access. Calls must be made within 30 days of submitting for App Review."* Screencast specs (1080+, monitor ≤1440 wide, English UI, larger cursor, *"Omit audio; our reviewers will not listen to it"*) and the five metrics (Impressions, Conversions, Spend, Clicks, Reach) all confirmed. Timeline verbatim: *"you should receive a decision within a week."* |
| 12 | Ad API access reverts to Development after 30 days of inactivity (10.4) | **CONFIRMED, wording corrected** | Actual text: *"Standard and Advanced Ads API access may be downgraded to Development access after 30 days of non-use."* The dossier had italicised a paraphrase as if it were a quote; fixed in §4.2 and §11. |
| 13 | 10.5 forbids combining end advertisers in one ad account | **CONFIRMED, wording corrected** | Actual tail is *"…or as otherwise approved by Meta in writing"*, not "or receive written Meta approval". The `vendor_id`/`brand` compliance path remains **secondary-sourced only** — still unverified. |
| 14 | 10.7(a) limits Meta advertising data to aggregate/anonymous campaign-effectiveness use | **CONFIRMED, and materially incomplete** | 10.7(a) verbatim. **Missing from the dossier and now added: 10.7(b), 10.7(f) and 10.7(g).** 10.7(g) — *"Keep Meta's data that you maintain on behalf of one advertiser separately from that of other advertisers"* — is a storage-architecture requirement, and 10.7(b) is the clause that actually constrains cross-tenant learning. |
| 15 | Sandbox: one per app, no funding, no delivery, no Insights, invisible in Ads Manager | **CONFIRMED** | Verbatim from the 2023 re-enable post: *"only one Sandbox ad account per app regardless of the access tier"*, *"impressions or spend will not be accumulated"*, *"Insights API is currently not supported because changes in the sandbox environment do not go live"*, *"Sandbox ad accounts cannot be operated from within Ads Manager directly. They can only be operated via Ads API."* Created under **Marketing API > Tools** after enabling the Marketing API product. |
| 16 | Campaigns can be created PAUSED; `special_ad_categories` required; ODAX enum | **CONFIRMED** | *"Only `ACTIVE` and `PAUSED` are valid during creation"* verbatim. Required fields `name`, `objective`, `special_ad_categories` confirmed; *"must indicate NONE or send an empty array"* confirmed. All six `OUTCOME_*` values present. **Note:** legacy objectives (`CONVERSIONS`, `LINK_CLICKS`, `REACH`, …) are **still listed in the published enum** — the dossier's "treat as dead for new builds" is sound advice but is guidance, not a documented removal. |
| 17 | `debug_token` `granular_scopes[].target_ids` reveals per-asset grants | **CONFIRMED** | Field present with documented shape `shape('scope' => string, 'target_ids' => ?int[],)[]`. `app_id`, `application`, `error`, `expires_at`, `data_access_expires_at`, `is_valid`, `issued_at`, `metadata`, `profile_id`, `scopes`, `user_id` all confirmed. Minor: the reference page's field list does **not** include a `type` field — the dossier lists one. Low stakes; don't depend on it. |
| 18 | Batch: 50 ops max, counted individually, bodies are JSON strings, partial `null` on timeout | **CONFIRMED** | *"Batch requests are limited to 50 requests per batch."* *"Each call within the batch is counted separately for the purposes of calculating API call limits and resource limits."* Body is a *"string encoded JSON object"*. Partial timeout returns `null` for incomplete ops alongside `200`s. `{result=REQUEST-NAME:$.data.*.id}` and `include_headers=false` confirmed. |

### Corrections applied to this document

1. **§1.2** — added the missing **Marketing API v26.0 (2026-07-29)** row, plus a note that Meta's own pages contradict each other on the current Marketing API version and that no `version26.0` Marketing changelog page exists (404).
2. **§4.2 and §11** — replaced the paraphrased Developer Policy 10.4 "quote" with the actual text.
3. **§8.3** — filled in the `custom_audience` BUC formula (`5000` / `190000` + 40 × active custom audiences, hard-capped at **700,000 calls/hour**) and recorded the complete `type` enum.
4. **§8.6** — corrected the ad-account **spend-limit** breach error to **`#17` / subcode `1885172`** (the dossier implied the `#613` family).
5. **§11** — corrected the 10.5 verbatim tail, and **added 10.7(b), 10.7(f), 10.7(g)**, which were missing.
6. **§11 design consequences** — hardened the cross-client-learning guidance to reflect 10.7(b) + 10.7(g), and added the per-tenant storage-isolation requirement.
7. **§6.2** — flagged `DRAFT` in the ad-account `tasks` enum as **unverified**; the asset-management guide documents only `['ANALYZE']`, `['ADVERTISE','ANALYZE']`, `['MANAGE','ADVERTISE','ANALYZE']`.
8. **§13** — resolved open questions **#7** (Marketing v26.0) and **#9** (`custom_audience` formula).

### Things the researcher missed (added above)

- **Developer Policy 10.7(b), 10.7(f), 10.7(g)** — 10.7(g)'s per-advertiser data-separation requirement is a schema-level constraint on the whole multi-tenant design, and 10.7(b) is a purpose limitation that makes cross-tenant model training presumptively non-compliant. The dossier's §11 discussed this risk but cited only the weaker 10.7(a).
- **Error `#17` / `1885172`** for spend-limit change frequency — a different error family from `#613`, so a handler that only branches on `#613` will misclassify it.
- **The 700,000 calls/hour hard cap** on the `custom_audience` BUC formula.
- **`ads_api_access_tier` still emits `development_access` / `standard_access`** after the May 2026 rename — the rate-limiting doc was re-checked on 2026-09-02 and still documents exactly those two strings. Open question #2 can be downgraded from "unknown" to "confirmed unchanged as of 2026-09-02", though defensive parsing remains the right call.
- **Legacy campaign objectives are still in the published enum.** Treating them as dead is correct engineering advice but is not backed by a documented removal — don't tell a reviewer or a client that Meta removed them.

### Still genuinely unverified after this pass

- `appsecret_time` — still absent from the securing-requests page. Unverified, as originally stated.
- Ad-account object ceilings (~5,000 campaigns / ad sets / ads). Secondary sources only; the Business Help Center page still does not render for extraction.
- The primary Meta document behind Developer Policy 10.5's *"requirements described [here]"* (the `vendor_id` / `brand` compliance path). Still only reachable via secondary reporting.
- Business Verification turnaround time — not documented.
- Whether `DRAFT` is a valid ad-account `tasks` value.
- Whether async ad request sets charge the ad-account point score per contained request or once per set.
- Per-app cap on client businesses connectable via Login for Business.
