# MiniMax H3 and AI usage accounting

## Video setup

New workspaces default to **MiniMax-H3**, **768P**, at **USD 0.08 per output second**. Existing saved provider selections are retained; select MiniMax H3 in Connections to switch future production. Saved/in-flight creatives retain their original provider and model.

Save a MiniMax **pay-as-you-go** API key in Connections. The same encrypted key can serve MiniMax engagement models; a coding-plan subscription does not provide H3 video access. H3 access and balance are verified by the first real task within the production allowance. Local tests use injected transports and do not establish account access.

The app generates two eight-second, 9:16 shots per creative: **$0.64 per shot / $1.28 per creative** at the default rate. Copy, narration, visual review, regenerated creative attempts and engagement requests cost extra. Aspect-ratio variants are rendered locally from the source video and do not create additional H3 requests.

The adapter uses `POST /v2/video_generation` with model `MiniMax-H3`, `content[]`, `duration: 8`, `resolution: 768P`, and `ratio: 9:16`. A product image uses `role: reference_image`; first-frame images would make the output ratio follow that image instead. Unsupported model IDs, resolutions, durations and options fail before a paid request. H3 exposes no audio-off flag; assembly uses the separately generated narration.

Poll `GET /v2/query/video_generation/{task_id}` and use the task's direct `content.url`. Responses must match the requested task, model and 768P tier. Record the usage receipt before downloading so download recovery cannot lose or duplicate charges. Do not resubmit a paid request after an uncertain outcome.

At the verified September 13, 2026 rates, H3 also charges $0.04 per image above the first five free images and charges input video at the output-resolution per-second rate. Input audio is free. Current production supplies at most one product image and no input video/audio. H3's returned token counts are retained for inspection but are not multiplied by a text-token rate.

## Usage & costs

The authenticated screen includes:

- UTC date range, workspace brand selection, provider, activity and cost-status filters; campaign/creative cost links open an attributed view.
- Separate calculated costs and estimates/reservations, with counts of unresolved and unpriced requests.
- Input, output, total, cached and reasoning tokens; audio token details when supplied; H3 input/output seconds and image counts; narration characters; Seedance pixel-frame tokens.
- Per-model and per-activity totals, expandable daily/brand/agent-role breakdowns, and a paginated request ledger.
- Request details with provider IDs, task IDs, attribution, attempt number, latency, HTTP status, rate snapshot and recognized numeric provider-usage fields.
- CSV export of all matching requests, independent of the current page. Exports above 10,000 rows require narrower filters; they never silently truncate. Every request retains six-decimal USD precision.

Cost states:

| State | Meaning |
| --- | --- |
| Calculated | Enough valid provider metrics were returned to calculate a cost using the saved rate. This is not an invoice-confirmed amount. |
| Estimated | The provider finished without a complete billing receipt, or the endpoint returns binary narration with no billed-character count. The original estimate remains visible. |
| Reserved | A paid request started and is awaiting its outcome; allowance has been reserved for production. |
| Unresolved | A timeout, incomplete historical record, or other uncertainty prevents reconciliation. Any known cost estimate remains in total exposure. |
| Not charged | A definitive pre-generation HTTP rejection without usage was recorded; its production reservation is released. |

Cached tokens are included in input tokens. Reasoning tokens are included in output tokens. They are displayed separately without adding them again to the total. Absent, malformed or inconsistent billing data is not interpreted as free usage. When a cache discount applies and cache counts are missing, the full request estimate is retained instead of assuming zero cache use. Dashes indicate unavailable or inapplicable metrics.

Every production attempt has its own charge reservation and receipt. A definitive retry gets a new attempt row and charge key, including when it occurs on a different brand-local day. A failed output that already consumed billable tokens keeps its cost. Repeated task polling cannot add the same charge again. SQLite transactions acquire effect ownership, request records and allowance together.

Daily production allowances apply in the brand's timezone. Engagement retains its separate daily request allowance (UTC); its USD costs are now included in this ledger but do not silently consume the production-only cap. Advertising spend remains in the account's currency in Overview and is not included in USD AI totals. Provider credits, invoice discounts, taxes and FX adjustments are not imported.

Historical charges migrate once as historical allowances/estimates. Historical engagement token totals migrate with unknown splits and costs. The app does not invent missing dates, rates or receipts. Completed legacy reservations are not reclassified as confirmed bills.

## Rates and future agent work

H3 and OpenAI input/output/cache rates are editable in Connections. Engagement token rates are editable through **Usage & costs → Model rates**. Defaults cover MiniMax M2.7, M2.7-highspeed, M3 (including its >512K input tier) and GLM-5.2. Prices are configuration snapshots; changing them affects future requests and never reprices recorded history. Narration currently uses `tts-1`, estimated at $15 per million requested Unicode characters.

Current workflow roles are recorded as brand researcher, copywriter, video producer, voice producer, creative reviewer, community manager and response reviewer. These labels establish accounting attribution. They do not imply that a parallel agent coordinator is already deployed. See [Agent Studio integration plan](AGENT-STUDIO-PLAN.md) for model-agnostic routing, shared learning, parallel execution, predicted workflow costs and ROI evaluation.

## API

All routes require the workspace session; mutations also require the existing CSRF/origin checks.

- `GET /api/usage`: `from`, `to`, `brand`, `provider`, `model`, `action`, `agent`, `status`, `run`, `creative`, `offset`, `limit` (1–200). Returns complete filtered totals/groupings plus the requested page of entries. Default page size is 50.
- `GET /api/usage/export`: the same filters; exports all matching rows up to the explicit 10,000-row limit.
- `GET /api/usage/pricing`: current engagement-model rate cards.
- `POST /api/usage/pricing`: a supported model `key`, numeric `input`, `output`, `cached` USD/M rates, and `longContext` rates for M3. Model keys and numeric ranges are validated. Secrets, endpoints and arbitrary models cannot be changed through this endpoint.

The ledger stores recognized numeric receipt fields and identifiers, not prompts, generated reasoning, API keys or comment bodies. It persists in the same SQLite database and backup volume as the workspace.

## Sources

Verified September 13, 2026: [H3 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create), [H3 task usage](https://platform.minimax.io/docs/api-reference/video-generation-v2-query), [MiniMax prices](https://platform.minimax.io/docs/guides/pricing-paygo), [MiniMax cache accounting](https://platform.minimax.io/docs/api-reference/text-prompt-caching), [Z.AI prices](https://docs.z.ai/guides/overview/pricing). OpenAI's existing configured text and narration rates remain editable/documented as estimates; keep them aligned with your account and selected model.
