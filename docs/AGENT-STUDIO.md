# Agent Studio

Agent Studio runs a coordinated creative team inside the existing Node 24 / SQLite / FFmpeg application. It does not require a separate orchestration service. New installations and upgraded brands start with agent coordination **off** until the owner chooses a mode and allowance.

## Start a team

1. Open **Agent studio** and select a brand. Existing OpenAI, MiniMax and GLM credentials remain available through **Connections**.
2. In **Model connections**, add any additional models, their public HTTPS API bases, capabilities and current rates. Supported formats are OpenAI Responses, OpenAI-compatible chat completions, Anthropic Messages, Gemini GenerateContent and OpenAI-compatible speech. Provider model access and pricing remain account-specific.
3. **Send paid test** makes a small metered request. Custom model versions must pass this test before use. A speech test checks the audio response contract; staging must still check pronunciation, duration and the assembled result. A vision connection test checks image-input acceptance, not review quality.
4. Assign a model to each role in **Your team**. Configure the role's daily and per-request USD allowances. Video production uses the provider selected in Connections; the H3 default is two 8-second shots at 768P and $0.08 per output second. Narration and reviews are additional.
5. Set workspace, brand and per-run allowances, concurrency and the performance-analysis cadence. Choose a mode and **Plan a run**. The quote sends no provider requests. Starting analysis or campaign production is a paid operation; simulation keeps the existing free deterministic path.

| Mode | Behavior |
| --- | --- |
| Off | Existing production workflow; configured production-role models still apply. No new coordinated analysis jobs. |
| Shadow | Periodic research/performance advice alongside the existing campaign workflow. Advice does not change budget decisions. |
| Review | Coordinated production pauses after the creative director approves the scripts. The owner approves before media generation. A current budget analyst can hold a proposed increase. |
| Automatic | Director-approved work proceeds into bounded media production without a second owner click. Deterministic creative, technical, account, audience, spending and Meta activation gates still apply. |

Changing models, rates or a brand's studio mode affects **new** runs. Existing runs retain model, video and rate snapshots. Turning coordination off cancels outstanding coordinated work. A global pause, brand pause or cancellation prevents new tasks and writes; already submitted provider jobs may still incur costs. Disabling a role blocks its next request. Required production roles cannot be omitted from a coordinated campaign.

## What runs together

Research and performance analysis run independently. Strategy waits for both. Copy tasks then run by funnel stage, while media and budget planners produce advisory recommendations. The director reviews the complete script batch. For each accepted creative, video and narration run independently; assembly waits for both, and visual review waits for assembly. Completed work returns to the existing campaign worker for audience setup, paused object creation and eligible activation.

SQLite stores each run, dependency, task, lease, attempt, short structured result and configuration version. Task claims and cost reservations use immediate transactions. Concurrency is bounded per brand, model endpoint and workspace. Meta mutations remain in the existing serialized worker so research does not occupy its emergency-pause queue.

Every request has a separate usage receipt, including rejected and failed attempts. Explicit fallbacks run only after a definitive failure and consume their own allowance. An unknown paid outcome is never blindly resent. Stale tasks with no ambiguous request resume from their saved dependencies and effects. If a run reports **uncertain**, reconcile the provider's receipt first. Review the original campaign, cancel its remaining production, and start a fresh cycle when appropriate; an invoice does not recover missing model output or authorize a duplicate generation.

## Memory and evidence

The team uses the approved brand claims, current unexpired shared memory, recent readable page knowledge and recent real ad observations. Campaign agent context is frozen at creation. Source text and earlier model outputs are treated as data; they cannot change instructions, capabilities or spending limits. Structured insight results must cite IDs present in the supplied evidence. The director and visual/technical checks can block production.

**Shared memory** separates owner-approved product facts from playbook lessons. Changes and restores create new versions; earlier versions remain visible. Entries may expire. Lessons have experiment/evaluation provenance and cannot become new product claims merely because an experiment performed well.

Performance advice is observational unless its experiment design establishes otherwise. The budget analyst may veto a scale proposal in review/automatic modes. It cannot make an unbounded budget change or overrule the deterministic optimization and account safeguards.

## Predicted and incurred costs

The run planner lists requests and expected token/video quantities by role. Its typical estimate uses explicit planning assumptions. Its upper estimate uses configured input/output ceilings and all selected fallback attempts, without assuming a cache discount. Video prices use the existing provider catalogue and the saved output specification. Local assembly is not an AI provider charge; record its operating costs separately. A revision is additional production and needs a new quote and available allowance.

Before every paid request, the ledger checks its conservative reservation against configured workspace, brand, role, request and coordinated-run allowances in one transaction. The existing brand production allowance is also retained for copy, media, narration and visual review. Daily studio limits use UTC; the legacy production allowance uses the brand's timezone.

Usage contains input, output, cache-read, cache-write where supplied, reasoning, video seconds and narration characters. Cache and reasoning subsets are not billed twice. Anthropic cache creation requires an explicit cache-write rate to become a calculated amount. Speech binary responses generally lack a billed-character receipt and stay estimated. The original provider receipt and rate remain intact when the owner adds an invoice reconciliation.

## Business outcomes and ROI

**Experiments & ROI** accepts confirmed order/CRM outcomes, qualified-outcome status, net revenue after refunds, and contribution after fulfilment costs. The authenticated UI and API both accept these records. The webhook uses the existing conversion bearer token:

```http
POST /api/webhooks/outcomes
Authorization: Bearer <conversion webhook token>
Content-Type: application/json
```

```json
{
  "brandId": "your-brand",
  "externalId": "order-123",
  "version": 1,
  "runId": "live-campaign-run-id",
  "adId": "",
  "occurredAt": "2026-09-01T12:00:00Z",
  "currency": "USD",
  "revenueMinor": 10000,
  "contributionMinor": 6000,
  "qualified": true
}
```

Use opaque business identifiers, without customer contact details. Identical retries are idempotent. A changed payload with the same revision is rejected. A refund uses the next consecutive revision of the same record and keeps the original attribution and timestamp. Its amounts replace the previous net amounts rather than adding another sale. Revenue cannot be negative; contribution may be negative when fulfilment/refund costs exceed retained revenue.

The reporting model is:

```
marketing cost = advertising spend + AI costs converted to brand currency + recorded operating costs
net marketing contribution = confirmed fulfilment contribution - marketing cost
net marketing ROI = net marketing contribution / marketing cost
```

This is marketing return after the recorded costs, not whole-company profit or a financial forecast guarantee. Meta-reported revenue is displayed separately and is never added to confirmed order revenue. The latest ad/day observation replaces older snapshots. Simulation is excluded. Final ROI is withheld for incomplete source coverage, unresolved costs, missing exchange rates or immature attribution. The provisional result and missing evidence remain visible.

Confirm source coverage through a date only after reconciling the Meta and order/CRM exports. Enter the exchange-rate date and source when mixing USD AI expenses with another account currency. Rates are frozen for each experiment. Report dates use the Meta account date for advertising and UTC for other ledger entries; reconcile boundary days when the account timezone differs.

Campaign comparisons include their production costs before launch, including failed attempts. Shared brand costs are shown at brand level; a campaign comparison with unallocated shared costs cannot claim complete ROI. Operating costs can be assigned to a run. Do not assign the full brand revenue to every model: the role breakdown is a cost breakdown, while outcome attribution belongs to campaigns and declared experiment arms.

## Experiments and learning

Register control/treatment live campaign runs, a hypothesis, fixed dates, minimum qualified outcomes, minimum improvement and the probability threshold. Runs cannot appear in both arms or in multiple experiments. An experiment records the comparison; it does **not** create a randomized audience split in Meta. An external randomized design requires the owner's split/reference record. Comparisons registered after observation starts are exploratory.

After the attribution window and reporting lag, evaluation checks coverage and all costs, requires at least 30 qualified outcomes in each arm, and uses deterministic seeded Gamma–Poisson efficiency draws with a Bayesian bootstrap of observed contribution values. The displayed probability is conditional on those assumptions and the declared design; it is not proof of a causal effect for observational campaigns. Low evidence yields insufficient/inconclusive results. Positive treatment net ROI and the fixed improvement threshold are required for promotion.

Equal contribution values share an exact aggregated bootstrap weight. To keep local evaluation bounded, more than 512 distinct contribution values in either arm withholds promotion and requires external statistical analysis. More than 100,000 stored Meta observations in a brand also marks the local ROI report incomplete. Outcome and cost revisions are selected by their latest version without truncating revision history. Configure a dated exchange rate before registering a non-USD experiment.

When revised outcomes or cost evidence no longer passes the promotion gate, reevaluation retires that experiment's active playbook lesson as a new memory version. Previous receipts, evaluations and memory versions remain available for audit.

The owner can promote an evaluated lesson into the playbook. Automatic promotion additionally requires the brand's opt-in, a preregistered external randomized comparison and all evidence gates. Promoted lessons expire after 30 days. Evaluations retain their evidence hash and results; revised business outcomes produce a new evaluation rather than rewriting the old evidence. **Explain with agents** runs the evaluator and learning curator against the deterministic result; they cannot change its verdict.

## Public pages rendered with JavaScript

The built-in crawler reads bounded public HTML. An optional **Workspace controls → page-rendering service** can supply rendered text for public pages. It receives:

```json
{"url":"https://brand.example/product","maxCharacters":24000}
```

It must return HTTP 200 JSON:

```json
{"requestedUrl":"https://brand.example/product","finalUrl":"https://brand.example/product","title":"Product","text":"Visible page text after rendering"}
```

This is an integration contract for an independently operated rendering service, not a bundled browser or a way to access private pages. The service must isolate browser sessions, enforce public HTTPS for navigation and every subresource, block private/reserved addresses and credential forwarding, cap redirects/resources/time, and return visible page text only. The application validates the service's public HTTPS address, pins public DNS for its request, matches the requested URL and bounds the response. Failed rendering blocks that page's knowledge refresh. Without a configured service, unreadable/JavaScript-only pages remain review cases.

## Release and activation boundary

Automated tests cover adapters and receipts, model versions, capability restrictions, atomic budgets, concurrent dependencies, owner approval, cancellation, stale leases, full coordinated campaign handoff, memory, refunds, currencies, cost reconciliation and experiment gates. HTTP tests exercise authentication, CSRF and rendering with real API response shapes. Provider transports are injected; no test calls a paid account.

For this update, the cloud browser's URL policy blocked the local test preview. A visual browser pass and fresh screenshots are therefore **not** claimed. Complete that review on the authorized deployed workspace before live activation. See [production activation](PRODUCTION-ACTIVATION.md) for the remaining external configuration and live-account checks.
