# Application integration contract

All owner API routes require the `sc_session` HTTP-only cookie. Mutations also require a same-origin `Origin` header and `X-CSRF-Token` from `GET /api/session`. First setup requires the server-generated setup token. Credentials are never returned through the owner API.

## Website conversions

Send requests from your website's **server**, using the conversion bearer token configured in Connections. Never ship that token to a public browser. The brand must be in Live mode with its pixel configured. The endpoint checks the collecting application's explicit consent flag, normalizes and hashes matching identifiers, persists the event, and queues delivery to Meta.

```http
POST /api/webhooks/conversions
Authorization: Bearer YOUR_CONVERSION_WEBHOOK_TOKEN
Content-Type: application/json
```

```json
{
  "brand_id": "your-brand",
  "consent": true,
  "event_name": "Purchase",
  "event_id": "order-12345",
  "event_time": 1789084800,
  "event_source_url": "https://your-brand.com/order/thank-you",
  "value": 89.0,
  "currency": "USD",
  "user_data": {
    "em": "customer@example.com",
    "ph": "+14155551234",
    "external_id": "customer-456",
    "fbp": "YOUR_CAPTURED_FBP",
    "fbc": "YOUR_CAPTURED_FBC"
  }
}
```

Replace `event_time` with the actual Unix timestamp in seconds; it must be within the preceding seven days and not in the future. Use the same `event_name` and `event_id` as the corresponding browser pixel event for Meta's deduplication. Repeating the same `brand_id` and `event_id` is idempotent in the local queue. IDs must uniquely identify the event, not merely the customer.

Accepted events: `Purchase`, `Lead`, `CompleteRegistration`, `Contact`, `Schedule`, `AddToCart`, `ViewContent`, and `Subscribe`. Purchases require nonnegative `value` and matching account `currency`. At least one of email, phone, external ID, or `fbc` is required. Email is trimmed and lowercased, phone becomes digits, and external IDs are trimmed and lowercased; these three fields are SHA-256 hashed by the server. Supply unhashed identifiers to this endpoint, not hashes. `fbp`, `fbc`, `client_ip_address`, and `client_user_agent` are transmitted as supplied. Only collect and send identifiers you are entitled to use.

The endpoint returns HTTP 202 after durable intake. That means queued, not yet accepted by Meta. Delivery uses the stable event ID across retries. A network failure can therefore result in repeated transport attempts without creating a new logical event. Errors are visible in Activity. Workspace pause also pauses queued deliveries.

For phone campaigns, inspect reporting keys from the brand’s **Check** dialog and set the verified call action key before enabling Live. The app deliberately does not substitute a messaging or link-click metric for a call. Other goals have defaults; the advanced result key can override a primary conversion metric while proxy funnel stages keep their own objectives.

The application forwards the supplied event value; it does not invent an order value or silently replace revenue with contribution margin. A configured ROAS target gates scaling against settled reported revenue. That gate is additional to the CPA/learning/attribution gates, not an independent statistical ROAS optimizer.

## Incoming Meta leads → CRM

Lead forms for Live brands are polled in an independent persistent job with `leads_retrieval` permission, including while that brand's advertising is paused. **Pause all** also stops collection and CRM delivery until the workspace resumes. Each synchronization saves its cursor after every page and yields after three pages so a large backlog cannot monopolize the worker. Completed scans overlap the previous seven days to collect delayed arrivals; stable Meta lead IDs prevent duplicate records. The [Meta lead retrieval contract](https://github.com/facebookincubator/catalogue-of-api-solutions/blob/main/solutions/leads/leads-retrieval-set-up-checker.md) defines the time filter used here.

New leads are stored and delivered to the brand's configured public HTTPS CRM webhook URL. Leads collected before a CRM is configured are queued when a destination is added. The endpoint must return a 2xx response. Redirects and destinations resolving to local/private addresses are rejected. Failed delivery remains visible and retries with delay. Advertising status and spending checks have priority over a CRM backlog. Lead counts and exports include the full stored history; data is not removed from Meta.

```json
{
  "type": "lead.created",
  "id": "META_LEAD_ID",
  "brandId": "your-brand",
  "createdAt": "2026-09-11T09:00:00Z",
  "fields": {
    "full_name": "Example Customer",
    "email": "customer@example.com",
    "phone_number": "+14155551234"
  }
}
```

Headers:

- `X-Event-ID`: stable lead ID; deduplicate this at the receiver.
- `X-Timestamp`: request Unix timestamp in seconds.
- `X-Signature-SHA256`: lowercase hex HMAC-SHA256 of `timestamp + "." + rawRequestBody`, keyed by the shared CRM signing secret.

Verify the signature with a constant-time comparison, reject stale request timestamps, and deduplicate the event ID before creating a CRM record. Delivery is **at least once**; a successful response lost in transit can lead to another request. Authentication is carried by the signature, not by credentials embedded in the URL. No external CRM adapter is assumed; any endpoint implementing this contract can receive leads.

## Runtime configuration

| Variable                                                   | Meaning                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `HOST`                                                     | Bind address; local default `127.0.0.1`, Docker `0.0.0.0`                               |
| `PORT`                                                     | HTTP listener, default `3000`                                                           |
| `APP_ORIGIN`                                               | Exact public HTTPS origin; mandatory in production                                      |
| `DATA_DIR`                                                 | Persistent database/key/media directory, default `data`                                 |
| `AUTOADS_MASTER_KEY`                                       | Optional 32-byte base64 encryption key; otherwise generated in the data directory       |
| `AUTOADS_SETUP_TOKEN`                                      | Optional pre-provisioned owner setup token; otherwise generated in the data directory   |
| `META_APP_ID`, `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN` | Server credential fallbacks when the corresponding connection has not been saved        |
| `OPENAI_API_KEY`, `SEEDANCE_API_KEY`                       | Provider credential fallbacks                                                           |
| `GOOGLE_SERVICE_ACCOUNT_JSON`                              | Google service account JSON; project, region and output bucket are configured in the UI |
| `CONVERSION_WEBHOOK_TOKEN`, `LEAD_WEBHOOK_SECRET`          | Integration credential fallbacks                                                        |

In-memory environment variables are read by Node; Docker Compose's sample passes `APP_ORIGIN` and uses UI-managed connections. If you want to pass additional environment credentials into the container, declare them in your Compose environment or secret-management setup. Merely adding them to Compose's interpolation `.env` does not inject them into the service.

The default OpenAI text/vision model is `gpt-4.1-mini`; narration uses `tts-1` with the generic Alloy voice. Script and visual-review responses use strict structured output and `store: false`. Review the [OpenAI structured-output contract](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) and [speech endpoint](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) when changing the provider implementation. Default text pricing is configurable in Connections. Narration reserves USD 15 per million UTF-16 code units; video estimates use the selected provider's checked-in model catalogue. These are estimates, not a provider billing guarantee.

## Operations

Use **Pause all** before rotating Meta credentials or performing maintenance. Wait for pending Meta pause requests to resolve before intentionally stopping the host. An unexpected crash is recoverable, but already active Meta campaigns continue on Meta while the host is offline; the account spending cap remains necessary.

For backups, stop the app and snapshot the complete workspace volume, including `master.key` and media. Restore it with restrictive filesystem permissions. Losing the key requires reconnecting credentials; losing the database also loses managed-object and spend history and should not be treated as a fresh workspace authorized to recreate running campaigns.

Queued transient errors retry with delay. After repeated ordinary run failures the campaign is blocked with a visible reason. Ambiguous paid submissions remain reserved and are not silently retried. Use the provider's task history and Activity to investigate; cancel the brand before starting an intentionally new attempt. The application does not bypass account restrictions, reviews, consent collection, ownership checks, or required asset setup.
