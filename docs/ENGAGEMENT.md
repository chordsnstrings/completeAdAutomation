# Page intelligence and ad engagement

Engagement gives each configured brand an inbox for Facebook and Instagram ad comments. Page intelligence reads each discovered ad destination, builds a source profile, and supplies that ad's context to MiniMax or GLM. Replies help with the question and invite the next action that fits the ad: a message, an enquiry form, or a visit to the destination.

## Configure a brand

1. Connect Facebook, select the relevant account and Page, and save the brand's actual Instagram account where applicable. Grant the comment permissions described in [Facebook setup](FACEBOOK-LOGIN.md).
2. In Connections, save a Z.AI or MiniMax API key. Keys are encrypted and are never returned to the browser. This is separate from the OpenAI connection used for creative production.
3. Open Engagement → the brand's Settings. Choose the provider, model, daily public-reply limit, and daily AI request limit. Enable page intelligence and optionally add public FAQ or product URLs. Ad destination URLs are discovered automatically.
4. Choose **Collect comments & draft for review** to inspect the results. Choose **Publish approved and verified AI replies** when you want the worker to post replies for new comments. Automatic publishing requires a Live brand. It is independent of advertising autonomy; a live brand can answer comments while new campaign creation is disabled.
5. Optionally add approved answers with example questions. These supplement the source context and provide deterministic replies for exact normalized question matches. Do not put uncertain claims or time-limited offers into evergreen answers.

Available provider IDs are explicit; failures do not silently switch providers:

| Provider | Models | API |
| --- | --- | --- |
| Z.AI | `glm-5.2` | `https://api.z.ai/api/paas/v4/chat/completions` |
| MiniMax | `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M3` | `https://api.minimax.io/v1/chat/completions` |

Verified against the providers' primary documentation: [GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2), [Z.AI chat completion](https://docs.z.ai/api-reference/llm/chat-completion), and [MiniMax's OpenAI-compatible API](https://platform.minimax.io/docs/api-reference/text-openai-api). Availability still depends on the supplied account and key. General API billing applies; this integration does not substitute a coding-plan endpoint.

## How page context stays attached to an ad

- Discovery reads the selected account's ads and identifies their Facebook post and Instagram media IDs. It includes ads already in the account, not only ads created by Spend Control, and restricts ownership to the brand's Page and configured Instagram actor. Shared posts are deduplicated. Instagram media ownership is checked before comment collection.
- Destination URLs come from the creative's link/video/template call to action and asset-feed URLs. When no URL is exposed, a non-messaging/non-native-form ad can use the brand's configured destination. Missing placement IDs and ambiguous shared-post destinations are visible and need review; dynamic or inaccessible destinations cannot be claimed as covered.
- Each distinct public HTTPS URL has its own brand-scoped record, readable text, title, content hash, last-read timestamp, and generated facts with supporting excerpts. Tracking parameters are removed without dropping functional query parameters. Profiles refresh daily.
- The crawler fetches a bounded HTML/text response, strips active content, and does not execute scripts, sign in, or submit forms. Private/reserved IPs, embedded credentials, unsupported schemes and ports, oversized responses, and unsafe redirects are rejected. Pages that require JavaScript, authentication, or bot clearance may need an alternative readable source. This limitation is visible; it is never reported as successful browsing.
- Replies use that thread's destination sources, ad copy, approved brand facts, and limited conversation context. Different brands do not share page knowledge. If a post belongs to ads with different destinations/actions, its AI reply requires review. Unreadable, failed, or stale sources also prevent automatic AI replies.

## Reply decisions

| Situation | Result |
| --- | --- |
| Exact approved question | The approved reply can be queued within the configured mode and allowance. |
| Question supported by the relevant page | The selected model drafts a concise reply, identifies supporting source excerpts, and performs a separate verification call. |
| Unknown answer or insufficient evidence | Review queue; no invented price, availability, promise, or policy. |
| Complaint, refund, order issue, sensitive information or suspicious instruction | Review queue. |
| Existing Page/Instagram response | Marked answered, with no further automatic reply. |
| Own-account comment or hidden comment | Ignored to avoid loops or unwanted responses. |
| Definite permission rejection | Failed/review state with a corrective explanation. |
| Timeout or uncertain send outcome | Reconciled from the actual conversation; no blind resend. |

AI drafts must pass structural validation, a confidence threshold, exact source-excerpt checks, brand exclusions, and the second model check. Source/page versions and the current comment are checked again before publishing. These checks reduce unsupported replies; model judgments are not proof of factual accuracy. The inbox exposes the evidence and lets the owner edit, approve, or close a conversation.

The server adds the invitation from the ad's destination: Messenger link, the ad's WhatsApp action, an Instagram message invitation, or the correct enquiry destination/native form instruction. It does not invent a lead-form URL, submit a form, proactively send private messages, request likes/tags/shares, or claim to be a human. Responding to incoming Messenger/WhatsApp **private-message threads** is a separate integration; this module handles public ad comments and their replies.

## Coverage, notifications and limits

The worker discovers ad posts every 15 minutes and checks known comments every 5 minutes. Facebook collection uses the comment stream; Instagram collection paginates comments and their replies. Retained posts continue to be checked after their ad is paused. Each edge is bounded at 10,000 returned items; a larger edge, inaccessible media, permission failure or repeating cursor produces a coverage error instead of silently reporting completeness.

Configure the HTTPS webhook URL from Connections in the Meta app. Save the same random verification token in both places. For Facebook, enable the Page `feed` field and use **Enable Facebook notifications** in Engagement settings to subscribe the app to that Page. Configure Instagram `comments` notifications in the Meta app for the connected professional accounts. Both Page and Instagram envelopes are supported. Periodic scans remain active if notifications are unavailable.

The receiver verifies `X-Hub-Signature-256` over the exact raw body and quickly queues durable checks. Repeated events coalesce into the same job and comments are deduplicated by platform ID. Unmanaged account notifications cannot trigger replies. Notifications that arrive during a scan are recovered by the next scan.

The inbox shows review items, confirmed replies, queued replies, and per-post last successful checks. Review items older than an hour are highlighted. Filters and pagination keep older comments accessible. Coverage does **not** mean a guarantee that every Meta comment is available or that every comment should receive an automatic response.

Public replies are limited per brand per UTC day. AI requests have a separate persistent daily count and returned token usage; profiling normally uses one request and a contextual draft plus verification uses two. Failed/interrupted model calls still consume the request allowance. It is a request limit, not a USD cap: configure billing/spend limits in the model provider account as well.

**Pause all**, off mode, changed brand assets, connection expiry/revocation, edited comments, stale evidence, or changed rules stop queued work as applicable. Expiry/revocation changes automatic engagement to review. Enabling auto mode does not mass-answer older comments. Reply intent is persisted before dispatch; an interrupted send never starts a second public reply merely because the process restarted.

## API and local verification

Owner-authenticated, CSRF-protected mutations:

- `POST /api/engagement/:brand` — save mode, provider, limits, sources, and approved answers.
- `POST /api/engagement/:brand/sync` — queue discovery and comment reconciliation.
- `POST /api/engagement/:brand/subscribe` — subscribe the Page's feed notifications.
- `POST /api/comments/:id/approve`, `/dismiss`, `/draft` — owner conversation actions.
- `POST /api/knowledge/:id/refresh` — refresh a source/profile.
- `GET /api/engagement/comments?brand=&status=attention&offset=0` — paginated inbox.
- `GET/POST /api/meta/webhook` — public verification and signed notifications.

`test/engagement.test.ts` verifies provider contracts with all network transport injected: per-destination profiles, Page authorization, both reply endpoints, deduplication, existing human answers, interrupted writes, privacy/security gates, model/evidence failures, stale source versions, budgets and review mode. `test/facebook-login.test.ts` covers OAuth, ownership, recovery, signed callbacks, webhook HTTP verification, and CSRF. Screenshots use the explicit disposable browser fixture and mocked provider responses. Real Meta and model access must be verified on the deployed workspace before enabling public replies.
