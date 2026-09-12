# Spend Control

A complete, self-hosted workspace for Meta advertising: a Swedish-inspired minimal interface, brand configuration, five funnel strategies, generated video creatives, paused staging, live delivery, reporting, and bounded autonomous optimization.

The application runs on **Node.js 24, SQLite, and FFmpeg**. The server owns credentials and external requests; the browser never receives provider tokens. Existing research, domain libraries, and CLI tools are retained.

## Run locally

Install Node.js 24+ and FFmpeg with libass, libx264, AAC, and DejaVu Sans available. On Debian/Ubuntu:

```bash
sudo apt-get install ffmpeg fonts-dejavu-core fonts-noto-core fonts-noto-cjk
npm ci
npm run build
npm start
```

Open **http://localhost:3000**. Read the one-time setup token from `data/setup-token` on your server and create an owner password of at least 12 characters. Do not share the setup token. Development with automatic server restarts uses `npm run dev`.

Choose **Explore a simulation** to add a clearly labelled example brand, then select **Run**. Simulation exercises planning, writing, local video assembly, quality checks, publishing adapters, activation state, and illustrative reporting without paid API calls. It renders actual 16-second test films in three formats; this takes a few minutes on a modest CPU. It does not simulate authentic provider-generated footage or prove access to a real ad account.

## Deploy with HTTPS

Point a hostname at a Linux server with ports 80 and 443 available and Docker Compose installed. Allow several GB of persistent disk space for generated videos; a multi-core CPU substantially reduces rendering time.

Create `.env` containing your hostname:

```dotenv
APP_HOST=ads.your-domain.com
```

Then:

```bash
docker compose up -d --build
docker compose exec app cat /app/data/setup-token
```

Caddy provides HTTPS. Visit your hostname and finish owner setup. The `workspace` volume contains the database, encrypted connections, master encryption key, and media. **Back up the entire volume together**; the database cannot decrypt saved credentials without its original `master.key`. For a consistent backup, stop the application before taking a volume snapshot, then restart it. Do not run `docker compose down -v` unless you intend to delete workspace data.

For another hosting platform, deploy the Dockerfile with a persistent volume at `/app/data`, set `APP_ORIGIN=https://your-hostname`, and put it behind an HTTPS proxy. This is a persistent Node service, not a static site or edge-worker bundle. Start one service instance per workspace; SQLite job leases also prevent competing workers from claiming the same work when they share the database. Do not put SQLite on a network filesystem or run independent copies of the same workspace database.

## Connect and launch

1. **Connections:** save a Meta app ID, app secret, and system user token; an OpenAI API key; and either a Seedance key or a Google Cloud service account, project, region, and output bucket. Discover assigned Pages and ad accounts in the interface.
2. **Meta Business Settings:** assign the system user to the ad account, Page, pixel, and any other required assets. Complete billing, app permissions, account verification, domain/event configuration, and any required advertising authorizations. Configure an **account spending limit in Meta**; the live preflight blocks an absent or exhausted cap. Set default DSA payor and beneficiary for EU advertising.
3. **Brands:** enter the destination, conversion goal, approved factual claims, creative constraints, account currency, daily advertising budget, maximum combined configured daily budget, and daily USD production allowance. Add a genuine product reference image when product fidelity matters.
4. **Funnel studio:** compare Single Engine, Seed & Harvest, Broad + Recapture, Full Three-Stage, and Value Ladder. The planner checks learning budgets and audience/history requirements. Connect existing customer lists or engagement audiences where required; the application cannot manufacture historical customer data.
5. **Staging:** run a full paid production cycle that creates Meta campaigns, ad sets, creatives, and ads **paused**. This is the account-specific rehearsal. It consumes production allowance but does not activate advertising.
6. **Live:** pause the staged brand, change its mode to Live, run its checks, and enable autonomy after reviewing the displayed budget. Live creates a new campaign hierarchy with its own recovery records. It never promotes a simulation or staging ID into live delivery.

After activation, the worker polls reporting, checks account/delivery state, waits for settled attribution and learning evidence, pauses poor performers, applies constrained budget changes, and queues evidence-driven creative iteration. Each funnel stage gets its own creative slate and brief. Internal copy, visual, and technical review failures get up to two fresh creative corrections within the production allowance. Routine Meta policy corrections are capped at two attempts per creative lineage and create a new ad in the original ad set. Rights-holder reports halt the lineage; authorization problems and unreadable feedback are quarantined. Findings and interventions remain visible in Decisions & activity.

Managed video-view audiences refresh as each new creative cycle is uploaded. Every 200 videos gets a separate audience, and all groups are included together in the next campaign's targeting. Existing groups retain their IDs and receive only changed rules. Audience IDs supplied by the owner are left under the owner's control.

### Supported destinations

| Goal                          | Required configuration                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website purchases / enquiries | HTTPS destination, assigned pixel/dataset, conversion event                                                                                                         |
| Instant lead forms            | Existing form ID, or privacy URL to create a form on the assigned Page                                                                                              |
| Messenger / WhatsApp          | Correctly connected Page and messaging destination assets                                                                                                           |
| Phone calls                   | E.164 telephone number, an eligible Meta account, and its verified call reporting action key                                                                        |
| Catalogue sales               | Product set and an existing **feed-based catalogue creative** in the same account; generated single-video creatives are not substituted for a product-feed template |
| Website visits                | HTTPS destination                                                                                                                                                   |
| App installs                  | Meta app ID and app store destination                                                                                                                               |

Actual eligibility, reviews, permissions, and destination behavior are enforced by Meta. A successful local test does not replace a successful staging run on the intended account.

## Spending and recovery

- Advertising amounts use the account currency and minor units internally. The UI keeps currencies separate and clearly distinguishes simulation data.
- The combined **configured daily budgets** of managed active campaigns cannot exceed the brand ceiling. A Meta daily budget is not a guaranteed single-day cash-spend limit. The native account spending cap is the hard backstop and includes other activity on that account.
- The optional brand total-spend stop uses reported spend and can overshoot because of reporting delay. It is not a native Meta lifetime budget.
- Generation reserves estimated USD costs before paid calls, including scripts, narration, video tasks, and visual review. Completed text responses settle against returned usage. Interrupted requests retain their reservation. Keep configured model prices current and set provider-side limits where available.
- SQLite persists jobs, leases, attempts, paid-request reservations, created-object ownership, decisions, and side effects. Restarting resumes work. If a Meta create times out, the application scans for its deterministic name before proceeding. An uncertain absent result stops instead of blindly duplicating a create. Retry rescans; if the provider cannot establish what happened, resolve it in the provider account or cancel the brand’s production and start a new cycle.
- **Pause all** persists the stop before external requests, blocks later activations, pauses managed campaigns, and retries unsuccessful Meta pauses. The UI explicitly reports pending pauses. It cannot stop Meta while Meta is unreachable, nor cancel an already accepted video-generation charge.
- Manual changes to campaign/ad set delivery in Meta pause automation rather than silently recreating the delivery you stopped. The application does not manage unrelated campaign IDs.

## Conversion feedback and CRM delivery

Set a conversion bearer token and CRM signing secret under Connections. See [the integration contract](docs/APP-INTEGRATIONS.md) for request examples, identifier hashing, stable event IDs, signature verification, and delivery semantics. Lead exports and reporting exports are authenticated CSV downloads. Treat the persistent volume and its backups as sensitive business data.

## Workflow regression coverage

`npm run test:workflows` runs the 45 combinations of five funnels and nine goals through injected live-mode provider contracts, plus performance changes, activation recovery, spending stops, currencies, and Seed & Harvest audience maturation. `npm test` includes these tests and the authenticated conversion/CRM integration suite.

The browser rehearsal uses `test/support/browser-server.ts` only with the explicit `SC_ENABLE_QA=1` opt-in. It creates a disposable SQLite workspace, intercepts external transports, and rejects unexpected requests. Production startup never imports it. Browser screenshots and the separate real FFmpeg assembly check are evidence of local behavior; they do not establish paid-provider access or real Meta delivery.

Recent recovery behavior:

- Incomplete activation is paused across every stage, and unsuccessful pauses remain durable priority work.
- Definitively rejected provider requests may retry; unknown outcomes remain reserved without another paid submission. A retry on another day must fit that day's production allowance.
- A mature, fully learned slate with zero primary results after at least ten target CPAs of settled spend per ad pauses for tracking and offer review.
- Seed & Harvest evaluates audience maturity after 30 days and adds eligible per-country conversion lookalikes as suggestions. Small audiences stop the seed; 100 observed purchases can end it early; 45 days is the final stop.
- A brand with real campaign or reporting history keeps its original ad account and currency. Use a separate brand for a different account or currency.
- Legacy COP, CRC, HUF, IDR and TWD configurations require an explicit budget review before live checks proceed. Saving reviewed values records the shared currency-unit convention.

## Verify

```bash
npm run build
node --check ui/app.js
npm test
```

GitHub Actions also builds the production Docker image and runs `node scripts/verify-container.mjs`. That check starts an isolated container, creates owner access, checks the API and static assets, saves an encrypted test connection, renders H.264/AAC video with fonts, and restarts the container to confirm persistent state. It makes no paid provider or Meta requests. Run it locally after `docker build -t spend-control:verify .` when Docker is available.

The tests include the original domain/API suites plus HTTP authentication and CSRF, persistent jobs and spend reservations, all five funnels and nine goals, staging/live transport contracts, ambiguous-write recovery, lineage repair, stopping behavior, SSRF checks, media ranges, secret redaction, and rendering every UI view with actual API response shapes. FFmpeg was additionally exercised through a complete local simulation with all three formats passing the existing quality gates.

**Verification boundary:** no live credentials are bundled. Live Meta delivery and paid provider generation must be verified using the intended account’s staging workflow. The Docker/HTTPS deployment requires your server and domain. The code tests do not certify advertising approval or financial outcomes.

## Project map

| Path                                                                        | Responsibility                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/`                                                                       | Responsive application, owner login, brand editing, reporting, campaign progress, creative inspection, funnel comparison, connections |
| `src/app/server.ts`                                                         | Authenticated HTTP API, setup, sessions, CSRF, static/media serving, exports and conversion intake                                    |
| `src/app/engine.ts`                                                         | Persistent pipeline, publishing, activation, monitoring, optimization, repair and emergency pause                                     |
| `src/app/production.ts`                                                     | Structured scripts, Seedance/Veo tasks, speech, FFmpeg assembly, technical and visual review                                          |
| `src/app/store.ts`, `security.ts`                                           | SQLite documents/jobs/effects/reservations and AES-GCM credential encryption                                                          |
| `src/app/meta.ts`, `network.ts`, `webhooks.ts`                              | Scoped Meta operations, reconciliation, public-URL checks and signed delivery                                                         |
| `src/meta/`, `src/funnel/`, `src/autonomy/`, `src/policy/`, `src/assembly/` | Existing typed, tested domain and integration libraries                                                                               |
| `docs/research/`                                                            | Original research and integration notes; research claims are not runtime verification                                                 |

The original `npm run preflight` and `npm run brands` CLI tools remain available. Their setup instructions are in [docs/SETUP.md](docs/SETUP.md).
