# Production activation

The repository supplies the application, runtime migrations, Docker image, worker and tests. Deployment and live provider permissions must be established on the intended account. A green unit/container test is not evidence of a live Meta launch.

| Check | Repository verification | Deployment/account verification |
| --- | --- | --- |
| Runtime | Node 24 build, tests and image smoke test | Persistent SQLite/media volume; worker health and disk capacity |
| Backups | SQLite persistence and restart tests | Back up the database consistently with its key and media; restore to a separate instance and verify access |
| HTTPS | Origin/CSRF/cookie handling | Domain, trusted TLS, `APP_ORIGIN`, reverse proxy and correct callback URLs |
| Meta owner access | OAuth ownership, one-use state, recovery, expiry and signed callback tests | App/login configuration, approved scopes, owner identity and asset assignment |
| Meta delivery | Paused staging, caps, activation compensation, priority pauses and eligibility checks | Billing, spending cap, Page/account/pixel eligibility, domain/event setup and advertising permissions |
| Models | API adapters, JSON schemas, usage normalization, capabilities and rates | Save credentials; run each selected model's paid test; inspect actual account-specific responses and prices |
| Media | H3/other provider contracts, narration, assembly and review gates | Run paid **staging** with the real product reference; inspect every format, narration and visual review |
| Agent controls | Concurrent claims, immutable snapshots, cost reservations, approvals and cancellation | Verify role allowances, cadence, chosen fallback providers and an initial review-mode run |
| Engagement | Signed comments, bounded grounded replies, verification and deduplication | Subscribe intended Pages, test eligible FB/IG comments and invitation targets; verify the destination knowledge |
| Page rendering | Bounded public crawler and optional rendering contract | Configure an isolated renderer if needed; unreadable pages must stay in review |
| Outcomes & ROI | Deduplication, refunds, fixed experiments, FX and cost reconciliation | Connect real order/CRM outcomes, confirm spend/outcome coverage and reconcile invoices |
| Interface | Syntax and API-shape rendering tests | Check desktop/mobile, dialogs, keyboard navigation, approvals and ROI presentation on the deployed site |

Recommended activation sequence:

1. Back up the existing volume, deploy the tested revision, and confirm `/healthz` and the worker status.
2. Connect the owner and only the assets the workspace is intended to manage. Run the existing connection checks for each brand.
3. Verify model connections and current rates. Set workspace, brand, role and run USD limits; retain a Meta account spending cap.
4. Complete one paid **staging** cycle. Confirm every Meta object is paused and inspect the rendered creatives, provider receipts and model choices.
5. Test a public comment requiring page evidence, one unsupported question that must enter review, an outcome webhook retry, and a refund revision.
6. Verify that a global pause blocks new agent work and pauses managed Meta delivery. Inspect any pending provider or Meta operations before resuming.
7. Complete the deployed visual/keyboard/mobile review. The local cloud-browser preview was blocked by URL policy during this update.
8. Enable live autonomy only for the intended brand and displayed advertising budget. Inspect the first actual delivery and matched business outcomes before increasing scope.

Do not mark source coverage complete based only on the presence of a few rows. Do not describe exploratory/observational comparisons as randomized evidence. Private-message inbox handling remains separate from the implemented public ad-comment engagement workflow.
