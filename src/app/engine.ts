import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MetaApiError } from "../meta/errors.ts";
import { RateLimited } from "../meta/scheduler.ts";
import { ProviderRequestError } from "../generation/provider.ts";
import { VideoUploader } from "../meta/videoUpload.ts";
import {
  buildCampaignRequest,
  buildAdSetRequest,
  buildCreativeRequest,
  buildAdRequest,
  currencyOffset,
} from "../meta/publish.ts";
import type { PublishRequest } from "../meta/publish.ts";
import { specFor } from "../meta/objectives.ts";
import {
  InsightsClient,
  creativeRewardQuery,
  actionValue,
  actionValueAmount,
  parseNumeric,
  parseNextPage,
} from "../meta/insights.ts";
import { decideSlate, gatesFor, proposeBudget } from "../autonomy/decide.ts";
import type { AdEvidence, LearningStatus } from "../autonomy/decide.ts";
import { createSeededRng } from "../autonomy/posterior.ts";
import {
  buildVideoViewAudienceRequests,
  buildLookalikeAudienceRequest,
  classifyAudienceReadiness,
  asStatusNode,
  AUDIENCE_READ_FIELDS,
} from "../funnel/audiences.ts";
import type { AudiencePoolSpec } from "../funnel/templates.ts";
import { RUNGS, AUDIENCE_POOLS } from "../funnel/templates.ts";
import { decideRemediation } from "../policy/screen.ts";
import type { ReviewFeedback, LineageState } from "../policy/screen.ts";
import { Store } from "./store.ts";
import { Vault } from "./security.ts";
import { MetaGateway } from "./meta.ts";
import { Production } from "./production.ts";
import type { publicBytes } from "./network.ts";
import { planFor } from "./planner.ts";
import { AppError, TransientAppError, DEFAULT_SETTINGS, nowIso } from "./types.ts";
import type {
  ManagedBrand,
  CampaignRun,
  Creative,
  Metric,
  Decision,
  Settings,
  Job,
  Lead,
  PublishedStage,
} from "./types.ts";

const PHASES = [
  "plan",
  "copy",
  "generate",
  "poll",
  "assemble",
  "screen",
  "audiences",
  "publish",
  "activate",
  "complete",
] as const;
interface VideoAudienceState {
  ids: string[];
  videoIds: string[];
  rules: string[];
}
interface LeadSyncState {
  since: number;
  scanStarted: number;
  after: string;
}
export interface EngineOptions {
  fetchImpl?: typeof fetch;
  production?: Production;
  meta?: MetaGateway;
  webhookTransport?: typeof publicBytes;
}
export class Engine {
  readonly store: Store;
  readonly vault: Vault;
  readonly meta: MetaGateway;
  readonly production: Production;
  private readonly webhookTransport: typeof publicBytes | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private readonly owner = randomUUID();
  constructor(store: Store, vault: Vault, options: EngineOptions = {}) {
    this.store = store;
    this.vault = vault;
    this.webhookTransport = options.webhookTransport;
    this.meta =
      options.meta ?? new MetaGateway(store, vault, options.fetchImpl);
    this.production =
      options.production ?? new Production(store, vault, options.fetchImpl);
  }
  settings(): Settings {
    return this.store.setting("app", DEFAULT_SETTINGS);
  }
  brand(id: string): ManagedBrand {
    const brand = this.store.get<ManagedBrand>("brands", id);
    if (!brand) throw new AppError("Brand not found.", 404);
    return brand;
  }
  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        console.error(this.vault.redact(String(e)));
      }
      this.timer = setTimeout(loop, 2000);
      this.timer.unref();
    };
    void loop();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  async drain(): Promise<void> {
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  createRun(brandId: string, replacementFor = ""): CampaignRun {
    const brand = this.brand(brandId);
    const pending = this.store
      .list<CampaignRun>("runs", brandId)
      .find((r) => ["queued", "running", "waiting"].includes(r.status));
    if (pending)
      throw new AppError(
        "This brand already has a campaign in production.",
        409,
      );
    if (this.settings().globalPaused)
      throw new AppError("Resume the workspace before starting a campaign.");
    if (brand.mode === "LIVE" && !brand.autonomy)
      throw new AppError(
        "Enable live autonomy for this brand before launching.",
      );
    if (
      brand.mode !== "SIMULATE" &&
      brand.preflight.some((c) => c.severity === "BLOCK")
    )
      throw new AppError("Resolve the connection checks before starting.");
    const active = this.store
      .list<CampaignRun>("runs", brandId)
      .find((r) => r.mode === brand.mode && r.stages.some((s) => s.active));
    const run: CampaignRun = {
      id: randomUUID(),
      brandId,
      mode: brand.mode,
      phase: "plan",
      status: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      nextAt: nowIso(),
      creativeIds: [],
      error: "",
      warnings: [],
      stages: [],
      generationCostUsd: 0,
      replacementFor: replacementFor || active?.id || "",
    };
    this.store.transaction(() => {
      this.store.put("runs", run);
      this.store.enqueue("run", run.id);
    });
    this.store.event(
      brandId,
      "info",
      "Campaign queued",
      `${run.mode === "SIMULATE" ? "Simulation" : run.mode === "STAGE" ? "Paused staging" : "Live campaign"} · ${run.id.slice(0, 8)}`,
    );
    return run;
  }
  async tick(): Promise<void> {
    if (this.busy || !this.store.lock("worker", this.owner)) return;
    this.busy = true;
    let job: Job | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const settings = this.settings();
      if (settings.emergencyPending) {
        await this.pauseAll();
        return;
      }
      if (settings.globalPaused) return;
      for (const brand of this.store.list<ManagedBrand>("brands")) {
        if (brand.autonomy)
          this.store.enqueue("monitor", brand.id, Date.now(), false);
        if (brand.mode === "LIVE" && brand.destination.leadFormId) {
          this.store.enqueue("lead-sync", brand.id, Date.now(), false);
          if (brand.leadWebhookUrl) this.store.enqueuePendingLeads(brand.id);
        }
      }
      job = this.store.claim();
      if (!job) return;
      heartbeat = setInterval(() => {
        if (job) {
          this.store.heartbeat(job);
          this.store.lock("worker", this.owner);
        }
      }, 20000);
      heartbeat.unref();
      let due: number | undefined;
      if (job.kind === "run") due = await this.advance(job.entityId);
      else if (job.kind === "monitor") {
        await this.monitor(job.entityId);
        due = Date.now() + this.settings().pollMinutes * 60000;
      } else if (job.kind === "conversion") {
        await this.sendConversion(job.entityId);
      } else if (job.kind === "lead") {
        await this.deliverLead(job.entityId);
      } else if (job.kind === "lead-sync") {
        const more = await this.syncLeads(this.brand(job.entityId));
        due = Date.now() + (more ? 1000 : this.settings().pollMinutes * 60000);
      } else if (job.kind === "pause") {
        await this.pauseBrand(job.entityId);
      }
      this.store.finish(job, due);
    } catch (e) {
      const message = this.vault.redact(
        e instanceof Error ? e.message : String(e),
      );
      if (job) {
        const stoppedRun =
          job.kind === "run"
            ? this.store.get<CampaignRun>("runs", job.entityId)
            : undefined;
        const correctable =
          /Creative screening blocked|Visual review blocked|Technical quality checks failed|narration needs to be between/.test(
            message,
          );
        if (
          stoppedRun &&
          stoppedRun.status !== "cancelled" &&
          correctable &&
          (stoppedRun.creativeRevision ?? 0) < 2
        ) {
          for (const creative of this.creatives(stoppedRun)) {
            creative.status = "blocked";
            this.store.put("creatives", creative);
          }
          stoppedRun.creativeRevision = (stoppedRun.creativeRevision ?? 0) + 1;
          stoppedRun.correctionFeedback = [
            ...(stoppedRun.correctionFeedback ?? []),
            message,
          ];
          stoppedRun.creativeIds = [];
          stoppedRun.phase = "copy";
          stoppedRun.status = "waiting";
          stoppedRun.error = message;
          const due = Date.now() + 30000;
          stoppedRun.nextAt = new Date(due).toISOString();
          this.store.put("runs", stoppedRun);
          this.store.finish(job, due);
          this.store.event(
            stoppedRun.brandId,
            "warning",
            `Creative correction ${stoppedRun.creativeRevision} of 2`,
            message,
          );
          return;
        }
        const transient =
          e instanceof RateLimited ||
          e instanceof TransientAppError ||
          (e instanceof ProviderRequestError && e.httpStatus === 429) ||
          (e instanceof MetaApiError && e.retryable) ||
          /fetch failed|timed out|ECONNRESET|ETIMEDOUT/.test(message);
        const allowance = message.includes("daily production allowance");
        const due = allowance
          ? Date.now() + 86400000
          : transient && job.attempt <= 8
            ? Date.now() +
              (e instanceof RateLimited || e instanceof TransientAppError
                ? e.retryAfterMs
                : Math.min(30 * 60000, 10000 * 2 ** job.attempt))
            : job.kind === "monitor" ||
                job.kind === "lead" ||
                job.kind === "lead-sync" ||
                job.kind === "conversion" ||
                job.kind === "pause"
              ? Date.now() + 3600000
              : undefined;
        this.store.finish(job, due, message);
        if (job.kind === "run") {
          const run = this.store.get<CampaignRun>("runs", job.entityId);
          if (run && run.status !== "cancelled") {
            run.status = due ? "waiting" : "blocked";
            run.error = message;
            run.updatedAt = nowIso();
            run.nextAt = due ? new Date(due).toISOString() : "";
            this.store.put("runs", run);
            this.store.event(
              run.brandId,
              due ? "warning" : "error",
              due ? "Waiting to retry" : "Campaign needs attention",
              message,
            );
          }
        } else {
          let brandId = job.entityId;
          if (job.kind === "lead") {
            const lead = this.store.get<Lead>("leads", job.entityId);
            if (lead) {
              lead.delivery = "failed";
              this.store.put("leads", lead);
              brandId = lead.brandId;
            }
          }
          this.store.event(
            brandId,
            "error",
            "Automation check stopped",
            message,
          );
        }
      } else throw e;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.busy = false;
      this.store.unlock("worker", this.owner);
    }
  }
  async advance(id: string): Promise<number | undefined> {
    const run = this.store.get<CampaignRun>("runs", id);
    if (!run || ["complete", "cancelled"].includes(run.status)) return;
    const brand = this.brand(run.brandId);
    if (brand.mode !== run.mode)
      throw new AppError(
        "This brand changed operating mode. Cancel this run and start a fresh one.",
      );
    if (run.mode === "LIVE" && !brand.autonomy)
      throw new AppError("Live autonomy is paused for this brand.");
    run.status = "running";
    run.error = "";
    run.updatedAt = nowIso();
    this.store.put("runs", run);
    const simulation = run.mode === "SIMULATE";
    let wait = 0;
    switch (run.phase) {
      case "plan": {
        run.plan = planFor(brand);
        run.warnings = [...run.plan.warnings];
        if (run.plan.refusal) throw new AppError(run.plan.refusal);
        if (run.repair)
          run.plan = {
            ...run.plan,
            stages: run.plan.stages.filter(
              (s) => s.stage.id === run.repair!.stageId,
            ),
          };
        const checks = await this.meta.check(brand);
        if (checks.some((c) => c.severity === "BLOCK"))
          throw new AppError(
            checks
              .filter((c) => c.severity === "BLOCK")
              .map((c) => `${c.name}: ${c.detail}`)
              .join("; "),
          );
        if (!simulation) {
          const connections = this.vault.status();
          if (!connections["openaiKey"])
            throw new AppError(
              "Connect OpenAI for scripts, narration and visual review.",
            );
          const provider = this.settings().provider;
          if (provider === "seedance" && !connections["seedanceKey"])
            throw new AppError("Connect Seedance in Connections.");
          if (provider === "veo" && !connections["googleServiceAccount"])
            throw new AppError(
              "Connect your Google service account in Connections.",
            );
        }
        break;
      }
      case "copy": {
        if (!run.creativeIds.length)
          run.creativeIds = (await this.production.draft(brand, run)).map(
            (c) => c.id,
          );
        break;
      }
      case "generate": {
        for (const c of this.creatives(run))
          await this.production.submit(brand, c, simulation);
        break;
      }
      case "poll": {
        let ready = true;
        for (const c of this.creatives(run))
          if (!(await this.production.poll(c, simulation))) ready = false;
        if (!ready) wait = 15000;
        break;
      }
      case "assemble": {
        for (const c of this.creatives(run))
          if (!c.file || c.qa.some((q) => q.severity === "BLOCK"))
            await this.production.render(brand, c, simulation);
        break;
      }
      case "screen": {
        for (const c of this.creatives(run)) {
          this.production.screen(brand, c);
          if (!c.visual) await this.production.visual(brand, c, simulation);
          if (
            c.visual?.verdict !== "PASS" ||
            c.qa.some((x) => x.severity === "BLOCK")
          )
            throw new AppError(
              "A creative has not passed every required review.",
            );
        }
        break;
      }
      case "audiences": {
        if (run.mode !== "VALIDATE") {
          // Include this cycle's uploaded videos before composing audience rules.
          await this.upload(brand, run);
          await this.audiences(brand, run);
        }
        break;
      }
      case "publish": {
        if (run.mode === "VALIDATE") {
          run.warnings.push(
            "Validation stops before object creation. Use staging to verify a full hierarchy with real, paused Meta objects.",
          );
          break;
        }
        await this.publish(brand, run);
        break;
      }
      case "activate": {
        if (run.mode === "LIVE" || simulation) {
          if (run.replacementFor && !run.repair)
            await this.pauseRun(run.replacementFor);
          await this.activate(brand, run);
        }
        break;
      }
      case "complete":
        return;
    }
    if (this.store.get<CampaignRun>("runs", id)?.status === "cancelled") return;
    if (!wait) {
      const at = PHASES.indexOf(run.phase);
      run.phase = PHASES[at + 1] ?? "complete";
    }
    run.status =
      run.phase === "complete" ? "complete" : wait ? "waiting" : "queued";
    run.updatedAt = nowIso();
    run.nextAt =
      run.phase === "complete" ? "" : new Date(Date.now() + wait).toISOString();
    run.generationCostUsd = this.creatives(run).reduce(
      (s, c) => s + c.generationEstimateUsd,
      0,
    );
    this.store.put("runs", run);
    if (simulation && run.phase === "complete" && !run.repair)
      this.simulatedMetrics(brand, [run]);
    this.store.event(
      brand.id,
      "success",
      run.phase === "complete"
        ? "Campaign ready"
        : `Completed ${PHASES[Math.max(0, PHASES.indexOf(run.phase) - 1)]}`,
      run.phase === "complete"
        ? simulation
          ? "Simulation completed. No live ads or paid generation were used."
          : run.mode === "STAGE"
            ? "All Meta objects are created and paused."
            : "Campaign activation completed. Reporting and optimization will continue."
        : "",
    );
    return run.phase === "complete" ? undefined : Date.now() + wait;
  }
  creatives(run: CampaignRun): Creative[] {
    return run.creativeIds
      .map((id) => this.store.get<Creative>("creatives", id))
      .filter((x): x is Creative => Boolean(x));
  }
  async audiences(brand: ManagedBrand, run: CampaignRun): Promise<void> {
    if (!run.plan) return;
    if (run.mode === "SIMULATE") {
      for (const pool of run.plan.audiencesToBuild)
        brand.audienceIds[pool.id] = `simulated_audience_${pool.id}`;
      this.saveAudiences(brand);
      return;
    }
    if (
      brand.archetype === "instant_form_lead" &&
      !brand.destination.leadFormId
    ) {
      if (!brand.privacyPolicyUrl)
        throw new AppError("Add a privacy policy URL to create the lead form.");
      brand.destination.leadFormId = await this.meta.create(
        `${brand.pageId}/leadgen_forms`,
        {
          name: `${brand.name} enquiries`,
          locale: brand.leadFormLocale,
          questions: JSON.stringify([
            { type: "FULL_NAME" },
            { type: "EMAIL" },
            { type: "PHONE" },
          ]),
          privacy_policy: JSON.stringify({
            url: brand.privacyPolicyUrl,
            link_text: "Privacy policy",
          }),
          follow_up_action_url: brand.destination.url ?? brand.privacyPolicyUrl,
        },
        `form:${brand.id}`,
        brand,
        "STAGE",
      );
      this.saveAudiences(brand);
    }
    const pools = [...run.plan.audiencesToBuild];
    if (pools.some((p) => p.kind === "union"))
      for (const key of [
        "site_visitors_30d",
        "atc_30d",
        "video_75_30d",
      ] as const)
        if (!pools.some((p) => p.id === key)) pools.push(AUDIENCE_POOLS[key]);
    for (const pool of pools) {
      if (pool.kind === "union") continue;
      if (pool.kind === "video") {
        await this.videoAudience(brand, run, pool);
        continue;
      }
      if (brand.audienceIds[pool.id]) continue;
      const needed = run.plan.stages.some((s) =>
        s.stage.target.includes(pool.id),
      );
      if (pool.kind === "customer_list") {
        if (needed)
          throw new AppError(`Select an existing audience for ${pool.label}.`);
        run.warnings.push(`${pool.label} has not been connected.`);
        continue;
      }
      if (pool.kind === "lookalike") continue; // Built from a connected seed below, or optional as a suggestion.
      if (pool.kind === "website") {
        if (!brand.destination.pixelId) {
          if (needed) throw new AppError(`${pool.label} requires a pixel.`);
          run.warnings.push(
            `Skipped ${pool.label}: this brand has no website pixel.`,
          );
          continue;
        }
        const event = pool.id.startsWith("purchasers")
          ? "Purchase"
          : pool.id.startsWith("atc")
            ? "AddToCart"
            : "PageView";
        const rule = {
          inclusions: {
            operator: "or",
            rules: [
              {
                event_sources: [
                  { id: brand.destination.pixelId, type: "pixel" },
                ],
                retention_seconds: pool.retentionDays * 86400,
                filter: {
                  operator: "and",
                  filters: [{ field: "event", operator: "eq", value: event }],
                },
              },
            ],
          },
        };
        brand.audienceIds[pool.id] = await this.meta.create(
          `${brand.adAccountId}/customaudiences`,
          {
            name: `${brand.name} · ${pool.label}`,
            rule: JSON.stringify(rule),
            prefill: "1",
          },
          `audience:${brand.id}:${pool.id}:${brand.destination.pixelId}`,
          brand,
          "STAGE",
        );
      } else if (pool.kind === "engagement") {
        if (needed)
          throw new AppError(
            `Connect ${pool.label} from an existing Meta audience.`,
          );
        continue;
      }
      this.saveAudiences(brand);
    }
    const seed = brand.audienceIds["customer_list_value"];
    if (
      seed &&
      !brand.audienceIds["lookalike_value_3pct"] &&
      run.plan.audiencesToBuild.some((p) => p.id === "lookalike_value_3pct")
    ) {
      const node = await this.meta.get<{
        approximate_count_lower_bound?: number;
      }>(seed, { fields: "approximate_count_lower_bound" }, brand.adAccountId);
      const req = buildLookalikeAudienceRequest({
        adAccountId: brand.adAccountId,
        name: `${brand.name} · Value lookalike`,
        seedAudienceId: seed,
        country: brand.countries[0]!,
        ratio: 0.03,
        seedSize: node.approximate_count_lower_bound ?? 0,
      });
      brand.audienceIds["lookalike_value_3pct"] = await this.meta.create(
        req.path,
        req.params,
        `audience:${brand.id}:value-lookalike`,
        brand,
        "STAGE",
      );
      this.saveAudiences(brand);
    }
    // Strict targeting requires a populated, ready audience. Suggestions and exclusions do not.
    for (const stage of run.plan.stages)
      for (const pool of stage.targetPools) {
        for (const id of this.poolIds(brand, pool)) {
          const node = asStatusNode(
            await this.meta.get(
              id,
              { fields: AUDIENCE_READ_FIELDS },
              brand.adAccountId,
            ),
            id,
          );
          const state = classifyAudienceReadiness(node);
          if (state.verdict === "wait")
            throw new RateLimited(
              brand.adAccountId,
              3600000,
              `${pool.label}: ${state.reason}`,
            );
          if (state.verdict === "fail")
            throw new AppError(`${pool.label}: ${state.reason}`);
        }
      }
  }
  videoAudienceKey(brand: ManagedBrand, pool: AudiencePoolSpec): string {
    return `video-audience:${brand.id}:${brand.adAccountId}:${brand.pageId}:${pool.id}`;
  }
  async videoAudience(
    brand: ManagedBrand,
    run: CampaignRun,
    pool: AudiencePoolSpec,
  ): Promise<void> {
    const key = this.videoAudienceKey(brand, pool);
    const state = this.store.setting<VideoAudienceState>(key, {
      ids: [],
      videoIds: [],
      rules: [],
    });
    const connected = brand.audienceIds[pool.id];
    // A supplied audience remains under its owner's control.
    if (connected && connected !== state.ids[0]) return;
    const videos = this.store
      .list<Creative>("creatives", brand.id, -1)
      .filter(
        (c) =>
          c.metaAccountId === brand.adAccountId &&
          c.metaPageId === brand.pageId &&
          /^\d+$/.test(c.videoId),
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      )
      .map((c) => c.videoId);
    // Append to stable chunks. Updating creative records must never reshuffle an existing pool.
    state.videoIds = [...new Set([...state.videoIds, ...videos])];
    if (!state.videoIds.length) {
      if (run.plan?.stages.some((s) => s.stage.target.includes(pool.id)))
        throw new AppError(
          `${pool.label} needs videos uploaded to the connected Page.`,
        );
      run.warnings.push(
        `${pool.label} will be available after a video upload.`,
      );
      return;
    }
    const requests = buildVideoViewAudienceRequests({
      adAccountId: brand.adAccountId,
      name: `${brand.name} · ${pool.label}`,
      pageId: brand.pageId,
      videoIds: state.videoIds,
      threshold: "p75",
      retentionDays: pool.retentionDays,
    });
    for (const [index, request] of requests.entries()) {
      const rule = request.params["rule"]!;
      const id = state.ids[index];
      if (!id) {
        state.ids[index] = await this.meta.create(
          request.path,
          request.params,
          `${key}:part:${index}`,
          brand,
          "STAGE",
        );
      } else if (state.rules[index] !== rule) {
        const owned = this.store.get<{ brandId: string; account: string }>(
          "objects",
          id,
        );
        if (owned?.brandId !== brand.id || owned.account !== brand.adAccountId)
          throw new AppError(
            "This audience is outside the managed campaign scope.",
          );
        // Replacing a rule is idempotent, including after an interrupted update.
        await this.meta.post(
          id,
          { rule, retention_days: String(pool.retentionDays) },
          brand,
          "STAGE",
        );
      }
      state.rules[index] = rule;
      this.store.setSetting(key, state);
    }
    brand.audienceIds[pool.id] = state.ids[0]!;
    this.saveAudiences(brand);
  }
  saveAudiences(brand: ManagedBrand): void {
    const current = this.brand(brand.id);
    current.audienceIds = { ...current.audienceIds, ...brand.audienceIds };
    if (brand.destination.leadFormId)
      current.destination.leadFormId = brand.destination.leadFormId;
    this.store.put("brands", current);
  }
  poolIds(brand: ManagedBrand, pool: AudiencePoolSpec): string[] {
    if (pool.kind === "union") {
      if (brand.audienceIds[pool.id]) return [brand.audienceIds[pool.id]!];
      return ["site_visitors_30d", "atc_30d", "video_75_30d"].flatMap((k) =>
        this.poolIds(brand, AUDIENCE_POOLS[k as keyof typeof AUDIENCE_POOLS]),
      );
    }
    const id = brand.audienceIds[pool.id];
    if (pool.id === "lookalike_campaign_conversions_3pct" && id && brand.mode !== "SIMULATE") {
      const group = this.store.setting<Record<string, string>>(`seed-lookalikes:${brand.id}:${brand.adAccountId}`, {});
      const ids = Object.values(group);
      if (ids[0] === id) return ids;
    }
    if (pool.kind === "video" && id && brand.mode !== "SIMULATE") {
      const state = this.store.setting<VideoAudienceState | null>(
        this.videoAudienceKey(brand, pool),
        null,
      );
      if (state?.ids[0] === id) return state.ids;
    }
    return id ? [id] : [];
  }
  request(
    brand: ManagedBrand,
    run: CampaignRun,
    index: number,
    c: Creative,
  ): PublishRequest {
    const stage = run.plan!.stages[index]!;
    let spec = stage.spec;
    const destination = { ...brand.destination };
    const rung = stage.arithmetic.rung;
    if (rung === "landing_page_view") {
      if (!destination.url)
        throw new AppError(
          "This budget requires a website-traffic strategy, but no website is configured. Increase the lead-generation budget or add a destination.",
        );
      spec = { ...specFor("traffic"), optimizationGoal: "LANDING_PAGE_VIEWS" };
    } else if (RUNGS[rung].pixelEvent && spec.promotedObject === "pixel_event")
      destination.customEventType = RUNGS[rung].pixelEvent!;
    const target = stage.targetPools.flatMap((p) => this.poolIds(brand, p)),
      suggest = stage.suggestPools.flatMap((p) => this.poolIds(brand, p)),
      exclude = stage.excludePools.flatMap((p) => this.poolIds(brand, p));
    if (stage.targetPools.length && !target.length)
      throw new AppError(
        `The ${stage.stage.label} stage has no connected target audience.`,
      );
    return {
      config: {
        brand: {
          ...brand,
          id: `b-${createHash("sha256").update(brand.id).digest("hex").slice(0, 8)}`,
        },
        spec,
        destination,
        dailyBudgetMinor: stage.dailyBudgetMinor,
      },
      account: brand.account ?? {
        adAccountId: brand.adAccountId,
        currency: brand.currency,
      },
      variant: createHash("sha256")
        .update(`${run.id}:${stage.stage.id}:${c.id}`)
        .digest("hex")
        .slice(0, 12),
      targeting: {
        geo: { countries: brand.countries },
        advantageAudience: stage.stage.advantageAudience,
        customAudienceIds: [...new Set([...target, ...suggest])],
        excludedCustomAudienceIds: [...new Set(exclude)],
      },
      creative: {
        videoId: c.videoId || "100000000000001",
        imageHash: c.imageHash || "placeholder",
        message: c.copy,
        title: c.headline,
        callToActionType:
          brand.archetype === "phone_call"
            ? "CALL_NOW"
            : (c.cta as PublishRequest["creative"]["callToActionType"]),
        ...(destination.url &&
        !["phone_call", "messenger_lead", "whatsapp_conversation"].includes(
          spec.archetype,
        )
          ? { link: destination.url }
          : {}),
        ...(destination.leadFormId
          ? { leadGenFormId: destination.leadFormId }
          : {}),
      },
      options: {
        budgetLevel: stage.stage.budgetLevel,
        adSetBudgetSharing: false,
        attributionSpec: [
          {
            eventType: "CLICK_THROUGH",
            windowDays: brand.attributionClickDays,
          },
          { eventType: "VIEW_THROUGH", windowDays: 1 },
        ],
        ...(stage.stage.maxDurationDays
          ? {
              endTime: new Date(
                Date.now() + stage.stage.maxDurationDays * 86400000,
              ).toISOString(),
            }
          : {}),
        now: Date.now(),
      },
    };
  }
  async upload(brand: ManagedBrand, run: CampaignRun): Promise<void> {
    for (const c of this.creatives(run)) {
      if (c.status === "blocked" || c.visual?.verdict !== "PASS")
        throw new AppError("Publishing requires a passed creative.");
      if (this.store.get<LineageState>("lineages", c.lineageId ?? c.id)?.halted)
        throw new AppError("This creative lineage is permanently halted.");
      const uploader = new VideoUploader({
        adAccountId: brand.adAccountId,
        accessToken: this.vault.get("metaToken"),
        appSecret: this.vault.get("metaAppSecret"),
        mode: run.mode,
        fetchImpl: this.meta.fetchImpl,
      });
      if (!c.videoId) {
        const result = await uploader.uploadSimple({
          bytes:
            run.mode === "SIMULATE" ? new Uint8Array() : readFileSync(c.file),
          filename: `${c.id}.mp4`,
          title: c.headline,
          isAiGenerated: true,
        });
        c.videoId = result.videoId;
        c.metaAccountId = brand.adAccountId;
        c.metaPageId = brand.pageId;
        this.store.put("creatives", c);
      }
      if (!c.imageHash) {
        await uploader.pollUntilReady(c.videoId);
        const image = await uploader.uploadAdImage({
          bytes:
            run.mode === "SIMULATE" ? new Uint8Array() : readFileSync(c.poster),
          filename: `${c.id}.jpg`,
        });
        c.imageHash = image.hash;
        this.store.put("creatives", c);
      }
    }
  }
  async publish(brand: ManagedBrand, run: CampaignRun): Promise<void> {
    if (!run.plan) throw new AppError("Missing campaign plan.");
    await this.upload(brand, run);
    for (let i = 0; i < run.plan.stages.length; i++) {
      const stage = run.plan.stages[i]!;
      if (run.stages.some((s) => s.stageId === stage.stage.id)) continue;
      const creatives = this.creatives(run).filter(
        (c) => !c.stageId || c.stageId === stage.stage.id,
      );
      const first = creatives[0];
      if (!first) throw new AppError("No creative is available.");
      const request = this.request(brand, run, i, first);
      const campaign = buildCampaignRequest(request);
      const source = run.repair
        ? this.store
            .get<CampaignRun>("runs", run.repair.sourceRunId)
            ?.stages.find((s) => s.stageId === run.repair!.stageId)
        : undefined;
      if (run.repair && !source)
        throw new AppError("The original ad set is missing.");
      const campaignId =
        source?.campaignId ??
        (await this.meta.create(
          campaign.path,
          campaign.params,
          `${run.id}:${stage.stage.id}:campaign`,
          brand,
          run.mode,
        ));
      const adset = buildAdSetRequest(request, { campaignId });
      const adSetId =
        source?.adSetId ??
        (await this.meta.create(
          adset.path,
          adset.params,
          `${run.id}:${stage.stage.id}:adset`,
          brand,
          run.mode,
        ));
      const published: PublishedStage = {
        stageId: stage.stage.id,
        campaignId,
        adSetId,
        adIds: [],
        dailyBudgetMinor: stage.dailyBudgetMinor,
        active: false,
        primaryAction: reportedAction(
          brand,
          request.config.spec.archetype,
          stage.arithmetic.rung,
          request.config.destination.customEventType,
        ),
        attributionClickDays: brand.attributionClickDays,
      };
      for (const c of creatives) {
        const req = this.request(brand, run, i, c);
        const cr =
          req.config.spec.archetype === "catalog_sales"
            ? undefined
            : buildCreativeRequest(req);
        const creativeId = cr
          ? await this.meta.create(
              cr.path,
              cr.params,
              `${run.id}:${stage.stage.id}:creative:${c.id}`,
              brand,
              run.mode,
            )
          : brand.catalogCreativeId || "simulated_catalog_creative";
        const ad = buildAdRequest(req, { adSetId, creativeId });
        const adId = await this.meta.create(
          ad.path,
          ad.params,
          `${run.id}:${stage.stage.id}:ad:${c.id}`,
          brand,
          run.mode,
        );
        published.adIds.push(adId);
        if (!c.adIds.includes(adId)) c.adIds.push(adId);
        c.status = "published";
        this.store.put("creatives", c);
      }
      run.stages.push(published);
      this.store.put("runs", run);
    }
  }
  async activate(brand: ManagedBrand, run: CampaignRun): Promise<void> {
    if (this.settings().globalPaused)
      throw new AppError("The workspace was paused during production.");
    if (run.repair) {
      const source = this.store.get<CampaignRun>(
          "runs",
          run.repair.sourceRunId,
        ),
        stage = source?.stages.find((s) => s.stageId === run.repair!.stageId);
      if (!source || !stage?.active)
        throw new AppError("The original campaign is no longer active.");
      for (const created of run.stages)
        for (const adId of created.adIds) {
          await this.meta.status(adId, "ACTIVE", brand, run.mode);
          if (!stage.adIds.includes(adId)) stage.adIds.push(adId);
        }
      this.store.put("runs", source);
      return;
    }
    const other = this.store
      .list<CampaignRun>("runs", brand.id)
      .filter((r) => r.id !== run.id && r.mode === run.mode)
      .flatMap((r) => r.stages)
      .filter((s) => s.active)
      .reduce((s, x) => s + x.dailyBudgetMinor, 0);
    const requested = run.stages.reduce((s, x) => s + x.dailyBudgetMinor, 0);
    if (other + requested > brand.spend.maxDailyBudgetMinor)
      throw new AppError(
        "Activation would exceed this brand’s combined daily budget ceiling.",
      );
    if (run.mode === "LIVE") {
      const checks = await this.meta.check(brand);
      if (checks.some((c) => c.severity === "BLOCK"))
        throw new AppError(
          checks
            .filter((c) => c.severity === "BLOCK")
            .map((c) => c.detail)
            .join("; "),
        );
      if (
        brand.lifetimeLimitMinor > 0 &&
        this.store.liveSpend(brand.id) >= brand.lifetimeLimitMinor
      )
        throw new AppError(
          "This brand has reached its lifetime spending limit.",
        );
    }
    try {
      for (const stage of run.stages) {
        if (stage.active && !stage.activationPending) continue;
        // Persist intent BEFORE the first write, including ambiguous/crashed activations.
        stage.activationPending = true;
        this.store.put("runs", run);
        for (const adId of stage.adIds)
          await this.meta.status(adId, "ACTIVE", brand, run.mode);
        await this.meta.status(stage.adSetId, "ACTIVE", brand, run.mode);
        await this.meta.status(stage.campaignId, "ACTIVE", brand, run.mode);
        stage.active = true;
        stage.activationPending = false;
        this.store.put("runs", run);
      }
    } catch (error) {
      try {
        await this.pauseRun(run.id);
      } catch (pauseError) {
        // Pause retries take priority over all production and monitoring work.
        const current = this.brand(brand.id);
        current.autonomy = false;
        this.store.put("brands", current);
        this.store.enqueue("pause", brand.id);
        this.store.event(brand.id, "error", "Launch recovery awaiting Meta", this.vault.redact(String(pauseError)));
      }
      throw error;
    }
  }
  async pauseRun(id: string): Promise<void> {
    const run = this.store.get<CampaignRun>("runs", id);
    if (!run) throw new AppError("Campaign not found.", 404);
    const brand = this.brand(run.brandId);
    let error: unknown;
    for (const stage of run.stages) {
      try {
        await this.meta.status(stage.campaignId, "PAUSED", brand, run.mode);
        stage.active = false;
        stage.activationPending = false;
        this.store.put("runs", run);
      } catch (e) {
        stage.activationPending = true;
        this.store.put("runs", run);
        error = e;
      }
    }
    if (error) throw error;
    this.store.event(brand.id, "info", "Campaign paused", run.id.slice(0, 8));
  }
  async pauseBrand(id: string): Promise<void> {
    const brand = this.brand(id);
    brand.autonomy = false;
    this.store.put("brands", brand);
    const runs = this.store.list<CampaignRun>("runs", id);
    for (const run of runs)
      if (["queued", "running", "waiting", "blocked"].includes(run.status)) {
        run.status = "cancelled";
        this.store.put("runs", run);
      }
    let error: unknown;
    for (const run of runs)
      try {
        await this.pauseRun(run.id);
      } catch (e) {
        error = e;
      }
    if (error) {
      this.store.enqueue("pause", id, Date.now() + 10000);
      throw error;
    }
  }
  async pauseAll(): Promise<void> {
    const settings = this.settings();
    settings.globalPaused = true;
    settings.emergencyPending = true;
    this.store.setSetting("app", settings);
    let failed = false;
    for (const brand of this.store.list<ManagedBrand>("brands"))
      try {
        await this.pauseBrand(brand.id);
      } catch (e) {
        failed = true;
        this.store.event(
          brand.id,
          "error",
          "Pause awaiting Meta",
          this.vault.redact(String(e)),
        );
      }
    settings.emergencyPending = failed;
    this.store.setSetting("app", settings);
  }
  retry(id: string): void {
    const run = this.store.get<CampaignRun>("runs", id);
    if (!run) throw new AppError("Campaign not found.", 404);
    if (run.status !== "blocked")
      throw new AppError("Only stopped campaigns can be retried.");
    run.status = "queued";
    run.error = "";
    this.store.put("runs", run);
    this.store.enqueue("run", id);
  }
  async monitor(id: string): Promise<void> {
    const brand = this.brand(id);
    if (!brand.autonomy) return;
    const runs = this.store
      .list<CampaignRun>("runs", id)
      .filter((r) => r.mode === brand.mode && r.stages.length > 0);
    // Incomplete or recovered runs can already be spending on Meta.
    const active = runs.filter((r) => r.stages.some((s) => s.active || s.activationPending));
    if (!active.length) {
      if (
        !this.store
          .list<CampaignRun>("runs", id)
          .some((r) =>
            ["queued", "running", "waiting", "blocked"].includes(r.status),
          )
      )
        this.createRun(id);
      return;
    }
    if (brand.mode === "SIMULATE") {
      this.simulatedMetrics(brand, active);
      return;
    }
    for (const run of active) {
      if (run.status !== "complete" || run.stages.some((s) => s.activationPending)) {
        try {
          await this.pauseRun(run.id);
          Object.assign(run, this.store.get<CampaignRun>("runs", run.id));
        } catch (error) {
          brand.autonomy = false;
          this.store.put("brands", brand);
          this.store.enqueue("pause", brand.id);
          throw error;
        }
      }
    }
    const client = new InsightsClient({
      transport: {
        get: <T>(path: string, params: Record<string, string>) =>
          this.meta.get<T>(path, params, brand.adAccountId),
        post: <T>(path: string, params: Record<string, string>) =>
          this.meta.post<T>(path, params, brand, "LIVE"),
      },
      now: () => new Date(),
    });
    const asOf = accountDay(brand);
    const rows = await client.fetch(
      creativeRewardQuery(brand.adAccountId, asOf),
    );
    for (const run of runs)
      for (const stage of run.stages)
        for (const row of rows) {
          const adId = String(row["ad_id"] ?? "");
          if (!stage.adIds.includes(adId)) continue;
          const date = String(row["date_start"] ?? asOf),
            observedAt = nowIso();
          const offset = currencyOffset(brand.currency);
          const metric: Metric = {
            id: `live:${adId}:${date}`,
            brandId: brand.id,
            runId: run.id,
            adId,
            adSetId: stage.adSetId,
            date,
            observedAt,
            currency: brand.currency,
            spendMinor: Math.round((parseNumeric(row["spend"]) ?? 0) * offset),
            impressions: parseNumeric(row["impressions"]) ?? 0,
            clicks: parseNumeric(row["clicks"]) ?? 0,
            conversions:
              stage.primaryAction === "reach"
                ? (parseNumeric(row["reach"]) ?? 0)
                : (actionValue(row, stage.primaryAction) ?? 0),
            revenueMinor: Math.round(
              (actionValueAmount(row, stage.primaryAction) ?? 0) * offset,
            ),
            attribution: String(row["attribution_setting"] ?? "UNKNOWN"),
            simulation: false,
            videoViews: actionValue(row, "video_view") ?? 0,
          };
          this.store.put("metrics", metric);
        }
    const metrics = latestMetrics(
      this.store.list<Metric>("metrics", id, 100000),
    ).filter((m) => !m.simulation);
    const spent = this.store.liveSpend(id);
    const today = this.store.liveSpend(id, asOf);
    if (
      (brand.lifetimeLimitMinor > 0 && spent >= brand.lifetimeLimitMinor) ||
      today >= brand.spend.maxDailyBudgetMinor * 1.75
    ) {
      await this.pauseBrand(id);
      this.store.event(
        id,
        "warning",
        "Spending limit reached",
        "Managed campaigns have been paused.",
      );
      return;
    }
    const checks = await this.meta.check(brand);
    if (checks.some((c) => c.severity === "BLOCK")) {
      await this.pauseBrand(id);
      throw new AppError(
        "The account check failed. Managed campaigns have been paused.",
      );
    }
    if (!(await this.reconcileDelivery(brand, active))) return;
    // Optional audience enrichment must never delay spend controls or optimization.
    for (const run of active) {
      if (run.status !== "complete") continue;
      try {
        await this.syncSeedLookalike(brand, run, metrics);
      } catch (error) {
        this.store.event(id, "warning", "Seed audience awaiting Meta", this.vault.redact(String(error)));
      }
    }
    for (const run of active)
      if (run.status === "complete") await this.optimize(brand, run, metrics, asOf);
    // Refresh only after mature evidence requests iteration; time alone is not fatigue.
    this.store.event(
      id,
      "success",
      "Performance updated",
      `${rows.length} reporting rows synchronized. Decisions use settled evidence and the current account status.`,
    );
  }
  async syncSeedLookalike(brand: ManagedBrand, run: CampaignRun, metrics: Metric[]): Promise<void> {
    if (brand.mode !== "LIVE" || run.plan?.templateId !== "seed_and_harvest") return;
    const seed = run.stages.find((s) => s.stageId === "seed");
    const harvest = run.stages.find((s) => s.stageId === "harvest");
    if (!seed || !harvest?.active) return;
    const age = (Date.now() - Date.parse(run.createdAt)) / 86400000;
    const purchases = harvest.primaryAction === actionFor("website_purchase", "", "PURCHASE")
      ? metrics.filter((m) => m.runId === run.id && harvest.adIds.includes(m.adId)).reduce((n, m) => n + m.conversions, 0)
      : 0;
    if (purchases >= 100 && seed.active) {
      await this.meta.status(seed.campaignId, "PAUSED", brand);
      seed.active = false;
      this.store.put("runs", run);
      this.store.event(brand.id, "success", "Seed stage completed", "The harvest stage has at least 100 reported purchases. Video seeding has stopped.");
    }
    if (age < 30) return;
    const key = "lookalike_campaign_conversions_3pct";
    if (!brand.audienceIds[key]) {
      const counts: number[] = [];
      for (const id of this.poolIds(brand, AUDIENCE_POOLS.video_75_90d)) {
        const node = await this.meta.get<{ approximate_count_lower_bound?: number }>(id, { fields: "approximate_count_lower_bound" }, brand.adAccountId);
        if (typeof node.approximate_count_lower_bound === "number" && node.approximate_count_lower_bound >= 0)
          counts.push(node.approximate_count_lower_bound);
      }
      // People may overlap across video chunks; do not sum and invent unique people.
      const lowerBound = counts.length ? Math.max(...counts) : undefined;
      if (lowerBound === undefined) return;
      if (lowerBound < 1000) {
        if (seed.active) {
          await this.meta.status(seed.campaignId, "PAUSED", brand);
          seed.active = false;
          this.store.put("runs", run);
          this.store.event(brand.id, "warning", "Seed stage stopped", "After 30 days the verified warm-audience lower bound is below 1,000. The harvest campaign continues independently.");
        }
        return;
      }
      const groupKey = `seed-lookalikes:${brand.id}:${brand.adAccountId}`;
      const group = this.store.setting<Record<string, string>>(groupKey, {});
      for (const country of brand.countries) {
        if (group[country]) continue;
        group[country] = await this.meta.create(`${brand.adAccountId}/customaudiences`, {
          name: `${brand.name} · Seed lookalike · ${country}`,
          subtype: "LOOKALIKE",
          lookalike_spec: JSON.stringify({ conversion_type: "campaign_conversions", origin_ids: seed.campaignId, country, ratio: 0.03 }),
        }, `seed-lookalike:${seed.campaignId}:${country}`, brand, "STAGE");
        this.store.setSetting(groupKey, group);
      }
      brand.audienceIds[key] = Object.values(group)[0]!;
      this.saveAudiences(brand);
    }
    const ids = this.poolIds(brand, AUDIENCE_POOLS[key]);
    for (const id of ids) {
      const node = await this.meta.get(id, { fields: AUDIENCE_READ_FIELDS }, brand.adAccountId);
      const readiness = classifyAudienceReadiness(asStatusNode(node, id));
      if (readiness.verdict === "wait") return;
      if (readiness.verdict === "fail") throw new AppError(readiness.reason);
    }
    const remote = await this.meta.get<{ targeting?: Record<string, unknown> }>(harvest.adSetId, { fields: "targeting" }, brand.adAccountId);
    if (!remote.targeting) throw new AppError("Meta did not return current harvest targeting. Audience changes are held.");
    const existing = Array.isArray(remote.targeting["custom_audiences"])
      ? remote.targeting["custom_audiences"] as Array<{ id: string }>
      : [];
    const additions = ids.filter((id) => !existing.some((item) => item.id === id));
    if (!additions.length) return;
    await this.meta.post(harvest.adSetId, { targeting: JSON.stringify({ ...remote.targeting, custom_audiences: [...existing, ...additions.map((id) => ({ id }))] }) }, brand, "LIVE");
    this.store.event(brand.id, "success", "Harvest audience enriched", "The ready seed lookalike is now a suggestion in the existing harvest ad set. Current geographic and exclusion settings were preserved.");
  }
  async optimize(
    brand: ManagedBrand,
    run: CampaignRun,
    metrics: Metric[],
    asOf: string,
  ): Promise<void> {
    for (const stage of run.stages) {
      if (!stage.active) continue;
      const state = await this.meta.get<{
        learning_stage_info?: { status?: string; last_sig_edit_ts?: number };
        attribution_spec?: Array<{ event_type: string; window_days: number }>;
      }>(
        stage.adSetId,
        { fields: "learning_stage_info,attribution_spec" },
        brand.adAccountId,
      );
      const click = state.attribution_spec?.find(
        (s) => s.event_type === "CLICK_THROUGH",
      )?.window_days;
      const learning = (
        ["LEARNING", "SUCCESS", "FAIL"].includes(
          state.learning_stage_info?.status ?? "",
        )
          ? state.learning_stage_info!.status
          : "UNKNOWN"
      ) as LearningStatus;
      const ads: AdEvidence[] = [];
      for (const adId of stage.adIds) {
        const node = await this.meta.get<{
          effective_status?: string;
          created_time?: string;
          ad_review_feedback?: {
            global?: Record<string, string>;
            placement_specific?: Record<string, Record<string, string>>;
          };
          creative?: { effective_authorization_category?: string };
        }>(
          adId,
          {
            fields:
              "effective_status,created_time,ad_review_feedback,creative{effective_authorization_category}",
          },
          brand.adAccountId,
        );
        const records = metrics.filter((m) => m.adId === adId);
        ads.push({
          adId,
          adSetId: stage.adSetId,
          rows: records.map((m) => ({
            statDate: m.date,
            spendMinor: m.spendMinor,
            conversions: m.conversions,
          })),
          ageDays: Math.floor(
            (Date.now() - Date.parse(node.created_time ?? run.createdAt)) /
              86400000,
          ),
          impressions: records.reduce((s, m) => s + m.impressions, 0),
          impressionsLast24h: records
            .filter(
              (m) =>
                m.date === asOf ||
                m.date ===
                  new Date(Date.parse(asOf) - 86400000)
                    .toISOString()
                    .slice(0, 10),
            )
            .reduce((s, m) => s + m.impressions, 0),
          effectiveStatus: node.effective_status ?? "UNKNOWN",
          learningStatus: learning,
          daysSinceSignificantEdit: state.learning_stage_info?.last_sig_edit_ts
            ? Math.floor(
                (Date.now() -
                  state.learning_stage_info.last_sig_edit_ts * 1000) /
                  86400000,
              )
            : 0,
          attributionSettings: [...new Set(records.map((m) => m.attribution))],
        });
        if (node.effective_status === "DISAPPROVED") {
          await this.repair(
            brand,
            run,
            stage,
            adId,
            {
              ...(node.ad_review_feedback?.global
                ? { global: node.ad_review_feedback.global }
                : {}),
              ...(node.ad_review_feedback?.placement_specific
                ? {
                    placementSpecific:
                      node.ad_review_feedback.placement_specific,
                  }
                : {}),
            },
            node.creative?.effective_authorization_category,
          );
        }
      }
      if (!click) {
        this.store.event(
          brand.id,
          "warning",
          "Optimization waiting",
          "Meta did not return the attribution window for this ad set.",
        );
        continue;
      }
      if (
        !stage.primaryAction ||
        stage.primaryAction !==
          (brand.resultActionType ||
            actionFor(brand.archetype, "", brand.destination.customEventType))
      )
        continue;
      const matureZeroResult = ads.filter((ad) => ad.effectiveStatus === "ACTIVE");
      if (matureZeroResult.length && learning === "SUCCESS" && matureZeroResult.every((ad) => {
        const settled = ad.rows.filter((row) => Date.parse(asOf) - Date.parse(row.statDate) >= click * 86400000);
        return ad.ageDays >= click && ad.daysSinceSignificantEdit >= click && ad.impressions >= 2000 &&
          settled.reduce((n, row) => n + row.spendMinor, 0) >= 10 * brand.spend.targetCpaMinor! &&
          settled.reduce((n, row) => n + row.conversions, 0) === 0;
      })) {
        // Relative comparison alone cannot reject a slate whose ads all return zero.
        // This is a spending stop, not a claim that a particular creative caused it.
        await this.pauseBrand(brand.id);
        this.store.put("decisions", { id: `zero-result:${run.id}:${stage.stageId}:${asOf}`, brandId: brand.id,
          runId: run.id, adId: stage.adSetId, action: "PAUSE", applied: true, simulation: false, createdAt: nowIso(),
          reason: "Every active ad has spent at least 10 times the target cost with zero settled results, after learning and attribution windows. Delivery paused for a conversion-tracking and offer review." });
        return;
      }
      const result = decideSlate({
        asOfDate: asOf,
        targetCpaMinor: brand.spend.targetCpaMinor!,
        gates: gatesFor(brand.spend.targetCpaMinor!, click),
        ads,
        rng: createSeededRng(
          Number.parseInt(
            createHash("sha256")
              .update(`${run.id}:${asOf}`)
              .digest("hex")
              .slice(0, 8),
            16,
          ),
        ),
      });
      for (const d of result.decisions) {
        const key = `${run.id}:${asOf}:${d.adId}:${d.verdict}`;
        if (this.store.get<Decision>("decisions", key)?.applied) continue;
        const decision: Decision = {
          id: key,
          brandId: brand.id,
          runId: run.id,
          adId: d.adId,
          action: d.verdict,
          reason: d.reason,
          createdAt: nowIso(),
          applied: false,
          simulation: false,
        };
        this.store.put("decisions", decision);
        if (run.mode === "LIVE" && d.verdict === "KILL") {
          await this.meta.status(d.adId, "PAUSED", brand);
          decision.applied = true;
        }
        if (run.mode === "LIVE" && d.verdict === "SCALE") {
          const settled = metrics.filter(
            (m) =>
              m.adId === d.adId &&
              m.date <
                new Date(Date.parse(asOf) - click * 86400000)
                  .toISOString()
                  .slice(0, 10),
          );
          const spend = settled.reduce((s, m) => s + m.spendMinor, 0),
            revenue = settled.reduce((s, m) => s + m.revenueMinor, 0);
          if (
            brand.spend.targetRoas &&
            (!spend || revenue / spend < brand.spend.targetRoas)
          )
            decision.reason +=
              " Budget held: settled revenue does not meet the ROAS target.";
          else
            decision.applied = await this.scale(
              brand,
              run,
              stage,
              learning,
              state.learning_stage_info?.last_sig_edit_ts ?? 0,
              asOf,
              decision,
            );
        }
        if (
          d.verdict === "ITERATE" &&
          !this.store
            .list<CampaignRun>("runs", brand.id)
            .some((r) =>
              ["queued", "running", "waiting", "blocked"].includes(r.status),
            )
        )
          this.createRun(brand.id, run.id);
        this.store.put("decisions", decision);
      }
    }
  }
  async reconcileDelivery(
    brand: ManagedBrand,
    runs: CampaignRun[],
  ): Promise<boolean> {
    let total = 0;
    for (const run of runs)
      for (const stage of run.stages) {
        if (!stage.active && !stage.activationPending) continue;
        if (stage.activationPending || run.status !== "complete") {
          // Fail closed after a crash or a launch that never reached completion.
          await this.pauseRun(run.id);
          this.store.event(brand.id, "warning", "Incomplete launch recovered", "Campaign delivery was paused before production can resume.");
          continue;
        }
        const campaign = await this.meta.get<{
          status?: string;
          daily_budget?: string;
        }>(
          stage.campaignId,
          { fields: "status,daily_budget" },
          brand.adAccountId,
        );
        const adset = await this.meta.get<{
          status?: string;
          daily_budget?: string;
        }>(stage.adSetId, { fields: "status,daily_budget" }, brand.adAccountId);
        const ended = run.plan?.stages.find((s) => s.stage.id === stage.stageId)
          ?.stage.maxDurationDays;
        if (
          ended &&
          Date.now() - Date.parse(run.createdAt) > ended * 86400000
        ) {
          await this.meta.status(stage.campaignId, "PAUSED", brand);
          stage.active = false;
          this.store.put("runs", run);
          continue;
        }
        if (campaign.status !== "ACTIVE" || adset.status !== "ACTIVE") {
          await this.pauseBrand(brand.id);
          this.store.event(
            brand.id,
            "warning",
            "Delivery changed in Meta",
            "Autonomy paused to respect the changed campaign or ad set status.",
          );
          return false;
        }
        const campaignBudget =
          run.plan?.stages.find((s) => s.stage.id === stage.stageId)?.stage
            .budgetLevel === "campaign";
        const budget = Number((campaignBudget ? campaign : adset).daily_budget);
        if (!Number.isSafeInteger(budget) || budget <= 0)
          throw new AppError(
            "Meta did not return a valid current daily budget. Budget changes are held.",
          );
        stage.dailyBudgetMinor = budget;
        total += budget;
        this.store.put("runs", run);
      }
    if (total > brand.spend.maxDailyBudgetMinor) {
      await this.pauseBrand(brand.id);
      this.store.event(
        brand.id,
        "warning",
        "Budget ceiling exceeded",
        "The current Meta budgets exceed the brand ceiling. Managed delivery has been paused.",
      );
      return false;
    }
    return true;
  }
  async scale(
    brand: ManagedBrand,
    run: CampaignRun,
    stage: PublishedStage,
    learning: LearningStatus,
    lastEdit: number,
    day: string,
    decision: Decision,
  ): Promise<boolean> {
    if (!this.brand(brand.id).autonomy || this.settings().globalPaused)
      return false;
    const prior = this.store.list<Decision>("decisions", brand.id).filter(
      (d) =>
        d.valueMinor !== undefined &&
        d.adId === stage.adSetId &&
        new Date(d.createdAt).toLocaleDateString("en-CA", {
          timeZone: brand.timezone,
        }) === day,
    );
    const total = this.store
      .list<CampaignRun>("runs", brand.id)
      .filter((r) => r.mode === "LIVE")
      .flatMap((r) => r.stages)
      .filter((s) => s.active)
      .reduce((s, x) => s + x.dailyBudgetMinor, 0);
    const context = {
      adSetId: stage.adSetId,
      currentMinor: stage.dailyBudgetMinor,
      minDailyBudgetMinor: brand.account?.minDailyBudgetMinor ?? 1,
      maxDailyBudgetMinor:
        brand.spend.maxDailyBudgetMinor - total + stage.dailyBudgetMinor,
      budgetWritesToday: prior.length,
      budgetChangesLastHour: prior.filter(
        (d) => Date.now() - Date.parse(d.createdAt) < 3600000,
      ).length,
      learningStatus: learning,
      daysSinceSignificantEdit: lastEdit
        ? Math.floor((Date.now() - lastEdit * 1000) / 86400000)
        : 0,
      hourOfDayAccountTz: Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: brand.timezone,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(new Date()),
      ),
      ...(prior.length
        ? { highWaterTodayMinor: Math.max(...prior.map((d) => d.valueMinor!)) }
        : {}),
    };
    const change = proposeBudget(
      context,
      Math.floor(stage.dailyBudgetMinor * 1.2),
    );
    if (change.action !== "SET" || change.valueMinor === undefined) {
      decision.reason += ` Budget held: ${change.reason}`;
      return false;
    }
    const target =
      run.plan?.stages.find((s) => s.stage.id === stage.stageId)?.stage
        .budgetLevel === "campaign"
        ? stage.campaignId
        : stage.adSetId;
    const key = `budget:${stage.adSetId}:${day}:${change.valueMinor}`;
    const intent: Decision = {
      ...decision,
      id: key,
      adId: stage.adSetId,
      valueMinor: change.valueMinor,
      action: "BUDGET",
      applied: false,
    };
    this.store.put("decisions", intent);
    await this.meta.post(
      target,
      { daily_budget: String(change.valueMinor) },
      brand,
      "LIVE",
    );
    stage.dailyBudgetMinor = change.valueMinor;
    intent.applied = true;
    this.store.put("decisions", intent);
    this.store.put("runs", run);
    return true;
  }
  async repair(
    brand: ManagedBrand,
    run: CampaignRun,
    stage: PublishedStage,
    adId: string,
    feedback: ReviewFeedback,
    authorization?: string,
  ): Promise<void> {
    const creative = this.store
      .list<Creative>("creatives", brand.id)
      .find((c) => c.adIds.includes(adId));
    if (!creative) return;
    const lineageId = creative.lineageId ?? creative.id;
    const lineage = this.store.get<LineageState>("lineages", lineageId) ?? {
      lineageId,
      attempts: 0,
      halted: false,
    };
    const verdict = decideRemediation({
      lineage,
      feedback,
      ...(authorization
        ? { effectiveAuthorizationCategory: authorization }
        : {}),
    });
    const key = `review:${adId}`;
    if (this.store.get<Decision>("decisions", key)?.applied) return;
    if (verdict.disposition === "HALT")
      this.store.put("lineages", {
        ...lineage,
        id: lineageId,
        brandId: brand.id,
        halted: true,
      });
    if (verdict.pauseScope === "lineage")
      for (const c of this.store
        .list<Creative>("creatives")
        .filter((c) => (c.lineageId ?? c.id) === lineageId))
        for (const id of c.adIds) await this.meta.status(id, "PAUSED", brand);
    else if (verdict.pauseScope === "campaign") await this.pauseBrand(brand.id);
    else await this.meta.status(adId, "PAUSED", brand);
    if (verdict.disposition === "RETRY") {
      if (
        this.store
          .list<CampaignRun>("runs", brand.id)
          .some((r) => ["queued", "running", "waiting"].includes(r.status))
      )
        return;
      const next = this.createRun(brand.id);
      next.replacementFor = "";
      next.repair = {
        sourceRunId: run.id,
        stageId: stage.stageId,
        adId,
        lineageId,
        attempt: lineage.attempts + 1,
        feedback: [...verdict.verbatimReasons],
      };
      this.store.transaction(() => {
        this.store.put("runs", next);
        this.store.put("lineages", {
          ...lineage,
          id: lineageId,
          brandId: brand.id,
          attempts: lineage.attempts + 1,
        });
      });
    }
    this.store.put("decisions", {
      id: key,
      brandId: brand.id,
      runId: run.id,
      adId,
      action: verdict.disposition,
      reason: verdict.reason,
      createdAt: nowIso(),
      applied: true,
      simulation: false,
    } satisfies Decision);
    this.store.event(
      brand.id,
      verdict.disposition === "RETRY" ? "warning" : "error",
      verdict.disposition === "RETRY"
        ? "Creative correction queued"
        : "Creative quarantined",
      verdict.reason,
    );
  }
  simulatedMetrics(brand: ManagedBrand, runs: CampaignRun[]): void {
    for (const run of runs)
      for (const stage of run.stages)
        for (let i = 0; i < stage.adIds.length; i++) {
          const adId = stage.adIds[i]!;
          for (let age = 0; age < 14; age++) {
            const date = new Date(Date.now() - age * 86400000)
                .toISOString()
                .slice(0, 10),
              id = `sim:${adId}:${date}`;
            if (this.store.get("metrics", id)) continue;
            const spend = Math.round(
              (stage.dailyBudgetMinor / stage.adIds.length) *
                (0.65 + (14 - age) * 0.02),
            );
            const conversions = Math.max(
              0,
              Math.floor(
                spend / (brand.spend.targetCpaMinor! * (0.7 + i * 0.3)),
              ),
            );
            this.store.put("metrics", {
              id,
              brandId: brand.id,
              runId: run.id,
              adId,
              adSetId: stage.adSetId,
              date,
              observedAt: nowIso(),
              currency: brand.currency,
              spendMinor: spend,
              impressions: Math.round(spend * 2.7),
              clicks: Math.round(spend * 0.038),
              conversions,
              revenueMinor:
                conversions *
                (brand.spend.contributionMarginMinor ??
                  brand.spend.targetCpaMinor! * 3),
              attribution: "7d_click,1d_view",
              simulation: true,
              videoViews: Math.round(spend * 0.62),
            } satisfies Metric);
          }
          const key = `sim:${adId}:hold`;
          this.store.put("decisions", {
            id: key,
            brandId: brand.id,
            runId: run.id,
            adId,
            action: i === 0 ? "SCALE" : i === 1 ? "HOLD" : "ITERATE",
            reason:
              "Illustrative simulation decision. No delivery or budget changes were sent to Meta.",
            createdAt: nowIso(),
            applied: false,
            simulation: true,
          } satisfies Decision);
        }
  }
  async syncLeads(brand: ManagedBrand): Promise<boolean> {
    const formId = brand.destination.leadFormId;
    if (!formId || brand.mode !== "LIVE") return false;
    const key = `lead-sync:${brand.id}:${formId}`;
    const state = this.store.setting<LeadSyncState>(key, {
      since: 0,
      scanStarted: 0,
      after: "",
    });
    if (!state.scanStarted) state.scanStarted = Math.floor(Date.now() / 1000);
    // Bound each job, not total history: save each page and yield to delivery/spend checks.
    for (let page = 0; page < 3; page++) {
      const path = `${formId}/leads`;
      const params: Record<string, string> = {
        fields: "id,created_time,field_data",
        limit: "100",
      };
      if (state.since)
        params["filtering"] = JSON.stringify([
          {
            field: "time_created",
            operator: "GREATER_THAN",
            value: Math.max(0, state.since - 7 * 86400),
          },
        ]);
      if (state.after) params["after"] = state.after;
      let out: {
        data: Array<{
          id: string;
          created_time?: string;
          field_data?: Array<{ name: string; values: string[] }>;
        }>;
        paging?: { next?: string; cursors?: { after?: string } };
      };
      try {
        out = await this.meta.get(path, params, brand.adAccountId);
      } catch (error) {
        if (
          state.after &&
          error instanceof MetaApiError &&
          error.code === 100 &&
          /cursor|paging/i.test(error.message)
        ) {
          state.after = "";
          this.store.setSetting(key, state);
          return true;
        }
        throw error;
      }
      if (!Array.isArray(out.data))
        throw new AppError("Meta returned an invalid lead page.");
      let after = "";
      if (out.paging?.next) {
        const next = parseNextPage(out.paging.next);
        if (next.path !== path)
          throw new AppError("Meta lead pagination changed its form.");
        after = next.params["after"] ?? out.paging.cursors?.after ?? "";
        if (!after || after === state.after)
          throw new AppError("Meta returned a repeating lead page.");
      }
      this.store.transaction(() => {
        for (const row of out.data) {
          if (!/^\d+$/.test(row.id))
            throw new AppError("Meta returned a lead without a valid ID.");
          const existing = this.store.get<Lead>("leads", row.id);
          if (existing) continue;
          const lead: Lead = {
            id: row.id,
            brandId: brand.id,
            formId,
            createdAt: row.created_time ?? nowIso(),
            fields: Object.fromEntries(
              (row.field_data ?? []).map((f) => [f.name, f.values.join(", ")]),
            ),
            delivery: "pending",
            deliveredAt: "",
          };
          this.store.put("leads", lead);
          if (brand.leadWebhookUrl) this.store.enqueue("lead", lead.id);
        }
        state.after = after;
        if (!after) {
          // Anchor to the scan start, not the newest record; delayed arrivals overlap for 7 days.
          state.since = state.scanStarted;
          state.scanStarted = 0;
        }
        this.store.setSetting(key, state);
      });
      if (!after) return false;
    }
    return true;
  }
  async deliverLead(id: string): Promise<void> {
    const lead = this.store.get<Lead>("leads", id);
    if (!lead || lead.delivery === "delivered") return;
    const brand = this.brand(lead.brandId);
    if (!brand.leadWebhookUrl) return;
    // Implemented in the HTTP integration layer, which pins and validates outbound URLs.
    const { deliverWebhook } = await import("./webhooks.ts");
    await deliverWebhook(
      brand.leadWebhookUrl,
      lead,
      this.vault.get("leadWebhookSecret"),
      this.webhookTransport,
    );
    lead.delivery = "delivered";
    lead.deliveredAt = nowIso();
    this.store.put("leads", lead);
  }
  async sendConversion(id: string): Promise<void> {
    const event = this.store.get<{
      id: string;
      brandId: string;
      payload: Record<string, unknown>;
      sent: boolean;
    }>("conversions", id);
    if (!event || event.sent) return;
    const brand = this.brand(event.brandId);
    if (!brand.destination.pixelId)
      throw new AppError("A pixel is required for conversion feedback.");
    if (brand.mode !== "LIVE")
      throw new AppError(
        "Live conversion feedback is enabled only for a live brand.",
      );
    await this.meta.post(
      `${brand.destination.pixelId}/events`,
      { data: JSON.stringify([event.payload]) },
      brand,
      "LIVE",
    );
    event.sent = true;
    this.store.put("conversions", event);
    this.store.event(
      brand.id,
      "success",
      "Conversion delivered",
      String(event.payload["event_name"]),
    );
  }
}
export function accountDay(brand: ManagedBrand): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: brand.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function latestMetrics(metrics: Metric[]): Metric[] {
  const map = new Map<string, Metric>();
  for (const m of metrics) {
    const key = `${m.adId}:${m.date}:${m.attribution}:${m.simulation}`;
    const prev = map.get(key);
    if (!prev || m.observedAt > prev.observedAt) map.set(key, m);
  }
  return [...map.values()];
}
function actionFor(archetype: string, rung: string, event?: string): string {
  if (rung === "thruplay") return "video_view";
  if (rung === "reach") return "reach";
  if (rung === "landing_page_view") return "landing_page_view";
  if (rung === "add_to_cart") return "offsite_conversion.fb_pixel_add_to_cart";
  if (rung === "view_content")
    return "offsite_conversion.fb_pixel_view_content";
  return (
    (
      {
        website_purchase: "offsite_conversion.fb_pixel_purchase",
        website_lead: "offsite_conversion.fb_pixel_lead",
        instant_form_lead: "lead",
        messenger_lead: "onsite_conversion.messaging_conversation_started_7d",
        whatsapp_conversation:
          "onsite_conversion.messaging_conversation_started_7d",
        phone_call: "",
        traffic: "landing_page_view",
        app_install: "mobile_app_install",
      } as Record<string, string>
    )[archetype] ??
    (event === "PURCHASE" ? "offsite_conversion.fb_pixel_purchase" : "lead")
  );
}

function reportedAction(
  brand: ManagedBrand,
  archetype: string,
  rung: string,
  event?: string,
): string {
  const action = actionFor(archetype, rung, event);
  return action ===
    actionFor(brand.archetype, "", brand.destination.customEventType)
    ? brand.resultActionType || action
    : action;
}
