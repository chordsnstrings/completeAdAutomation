# Facebook login and business access

Spend Control uses Facebook Login for Business for owner sign-in and user-authorized business assets. You still register **one Meta developer app**. OAuth is the connection and consent flow for that app; a separate end-user application is not needed for each Page or ad account.

## One-time setup

1. Host the Node service at a public HTTPS origin and set `APP_ORIGIN` to that exact origin. Docker Compose derives it from `APP_HOST`. Other runtimes must supply environment variables explicitly; `npm start` does not load `.env` automatically.
2. Create or configure the Meta app for the business using the current app dashboard. Add Facebook Login for Business and create a configuration that issues a **User access token**. This flow verifies a human workspace owner; a business/system-user token cannot establish that identity.
3. Configure these URLs using your own hostname:

| Meta setting | Workspace path |
| --- | --- |
| Valid OAuth redirect URI | `/api/meta/oauth/callback` |
| Privacy policy | `/privacy` |
| Deauthorization callback | `/api/meta/deauthorize` |
| Data-deletion callback | `/api/meta/data-deletion` |
| Data-removal instructions | `/data-deletion` |
| Comment webhook callback | `/api/meta/webhook` |

4. On first setup, enter the workspace setup token from `DATA_DIR/setup-token`, the Meta app ID, app secret, and Login configuration ID. Continue with Facebook. An existing password owner can save these under Connections, then connect Facebook from that authenticated session.
5. Select the ad accounts and Pages this workspace should manage. Discovery retrieves all returned pages of accessible accounts, Pages, and optional business portfolios. Connected Instagram profiles are attached to their Pages. A brand's account and Page must be selected before real advertising or engagement is enabled.
6. Use Brands to choose assets by name. Refresh its connected assets to select a pixel, Instagram account, or lead form. Account currency and timezone are taken from the selected account; review the displayed budgets before saving.
7. Add an optional recovery password in Account settings. Keep the setup token and full workspace backup separately from ordinary browser access.

## Permissions and access levels

Configure only the permissions needed for the workflows you intend to use. Consent, app access level, the person's role, and asset assignments all affect the result.

| Workflow | Permissions used |
| --- | --- |
| Advertising | `ads_read`, `ads_management` |
| Page discovery and content | `pages_show_list`, `pages_read_engagement` |
| Page advertising and lead forms | `pages_manage_ads` |
| Existing form enquiries | `leads_retrieval` |
| Connected Instagram account | `instagram_basic` |
| Optional business portfolio discovery | `business_management` |
| Facebook comment collection and replies | `pages_read_user_content`, `pages_manage_engagement` |
| Page webhook subscription | `pages_manage_metadata` |
| Instagram comment collection and replies | `instagram_manage_comments` |

Check the current Meta dashboard for App Review, Advanced Access, business verification, and live-mode requirements for **each permission and intended user population**. Owning an ad account is not a blanket exemption for every Page or Instagram permission. Missing optional access is displayed as a discovery warning; it does not fabricate assets or invalidate unrelated account access.

Primary references: [Meta's Marketing API collection](https://www.postman.com/meta/facebook-marketing-api/documentation/0zr4mes/facebook-marketing-api-mapi) and [Meta's Instagram API with Facebook Login examples](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

## Authorization and recovery behavior

- Authorization codes are exchanged on the server. Both short and extended tokens are verified against the configured app, user, token type, and returned expiry metadata. The profile ID must match the verified user.
- OAuth state is single use, expires after ten minutes, and is bound to a separate HttpOnly browser cookie. Connecting from an existing session also requires that original owner session to remain valid. Replacing configuration invalidates an in-flight flow.
- Owner sign-in is restricted to the linked app-scoped Facebook ID. Knowing or accessing one of the same ad accounts does not grant workspace login.
- User and Page tokens are encrypted with the workspace key. Public asset records and bootstrap data contain no provider tokens. Page operations use their Page authorization; advertising uses the user authorization.
- Logging out ends the browser session and leaves the background authorization intact. Disconnect advertising requests pauses and retains credentials until all required stops are confirmed.
- Expiry or revocation stops new real autonomous advertising, queues delivery stops, and changes automatic engagement to review mode. Existing Meta delivery can continue if its pause cannot be authorized. Reconnect never turns brand advertising back on automatically.
- Losing both the Facebook grant and recovery password does not reopen public setup. The server's setup token can establish a replacement owner; this invalidates existing sessions and leaves real advertising paused locally with pending stop jobs.
- Signed removal callbacks remove the Facebook identity, tokens, asset cache, lead/conversion submissions, comment records, and page knowledge. Campaign IDs and business reporting history are retained for delivery recovery. Notifications older than a subsequent grant cannot remove that new grant. Backup and external-provider removal remain the operator's responsibility.

## System-user alternative

Connections retains an advanced system-user token option for assigned business assets. Facebook can still identify the workspace owner while background advertising uses that manual connection. Stop real work before changing between authorization methods. The legacy CLI continues to use its system-user configuration; this document describes the web workspace.

## Deployment verification

Local tests use injected provider responses. Before enabling real work, verify the production HTTPS callback with the actual Meta app, complete consent with the intended owner, check returned permissions and asset tasks, run the intended account's preflight/staging workflow, and test comment collection and one approved reply on an account you control. Neither a mock test nor a screenshot establishes live Meta access.
