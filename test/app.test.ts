import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { Store } from "../src/app/store.ts";
import { Vault, setupToken } from "../src/app/security.ts";
import { Engine, latestMetrics } from "../src/app/engine.ts";
import { MetaGateway } from "../src/app/meta.ts";
import { Production } from "../src/app/production.ts";
import { createApp, csv } from "../src/app/server.ts";
import { validateManagedBrand } from "../src/app/validation.ts";
import { conversionPayload } from "../src/app/webhooks.ts";
import { publicIp } from "../src/app/network.ts";
import { DEFAULT_SETTINGS, nowIso } from "../src/app/types.ts";
import { AppError } from "../src/app/types.ts";
import type {
  Creative,
  ManagedBrand,
  CampaignRun,
  Metric,
} from "../src/app/types.ts";
import { allPlans, planFor } from "../src/app/planner.ts";
import { RateLimited } from "../src/meta/scheduler.ts";
import { runInNewContext } from "node:vm";
import { AUDIENCE_POOLS } from "../src/funnel/templates.ts";
import type { Lead } from "../src/app/types.ts";

function fixture(overrides: Record<string, unknown> = {}): ManagedBrand {
  return validateManagedBrand({
    id: "nord",
    name: "NORD Objects",
    archetype: "website_purchase",
    destination: {
      url: "https://example.com",
      pixelId: "123456789",
      customEventType: "PURCHASE",
    },
    spend: {
      dailyBudgetMinor: 50000,
      maxDailyBudgetMinor: 100000,
      targetCpaMinor: 1000,
    },
    claims: {
      substantiated: [
        "Considered objects for everyday living.",
        "Explore the NORD collection.",
      ],
    },
    countries: ["US"],
    currency: "USD",
    timezone: "America/New_York",
    proposition: "Simple ceramic objects for everyday living.",
    mode: "SIMULATE",
    funnel: "single_engine",
    creativesPerCycle: 1,
    ...overrides,
  });
}
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "ad-app-"));
  const store = new Store(dir),
    vault = new Vault(store);
  return {
    dir,
    store,
    vault,
    clean: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("failed visual checks get two fresh, bounded corrections and then stop", async () => {
  const w = workspace();
  try {
    class BlockedProduction extends TestProduction {
      override async visual(_b: ManagedBrand, _c: Creative): Promise<void> {
        throw new AppError(
          "Visual review blocked this creative: unapproved product feature.",
        );
      }
    }
    w.store.put("brands", fixture());
    const e = new Engine(w.store, w.vault, {
      production: new BlockedProduction(w.store, w.vault),
    });
    const run = e.createRun("nord");
    for (let i = 0; i < 40; i++) {
      w.store.db.prepare("UPDATE jobs SET due=0 WHERE state='queued'").run();
      await e.tick();
      if (w.store.get<CampaignRun>("runs", run.id)?.status === "blocked") break;
    }
    const result = w.store.get<CampaignRun>("runs", run.id)!;
    assert.equal(result.status, "blocked");
    assert.equal(result.creativeRevision, 2);
    assert.equal(w.store.list<Creative>("creatives").length, 3);
    assert.equal(result.stages.length, 0);
  } finally {
    w.clean();
  }
});
class TestProduction extends Production {
  override async draft(b: ManagedBrand, r: CampaignRun) {
    return super.draft(b, { ...r, mode: "SIMULATE" });
  }
  override async submit(b: ManagedBrand, c: Creative) {
    return super.submit(b, c, true);
  }
  override async poll() {
    return true;
  }
  override async render(_b: ManagedBrand, c: Creative) {
    const dir = join(this.store.dir, "media", c.id);
    mkdirSync(dir, { recursive: true });
    c.file = join(dir, "9x16.mp4");
    c.poster = join(dir, "poster.jpg");
    writeFileSync(c.file, "0123456789");
    writeFileSync(c.poster, "image");
    c.variants = { "9:16": c.file };
    c.qa = [
      {
        name: "Test renderer",
        severity: "PASS",
        detail: "Injected test media.",
      },
    ];
    c.videoId = "123456789101112";
    c.imageHash = "test-image-hash";
    this.store.put("creatives", c);
  }
  override async visual(b: ManagedBrand, c: Creative) {
    return super.visual(b, c, true);
  }
}
async function finish(e: Engine, id: string) {
  for (let i = 0; i < 14; i++) {
    await e.advance(id);
    const r = e.store.get<CampaignRun>("runs", id)!;
    if (r.status === "complete") return r;
  }
  throw new Error("Pipeline did not finish.");
}
test("video audiences keep all chunks, refresh only changed rules, and respect manual audiences", async () => {
  const w = workspace();
  try {
    const b = fixture({ mode: "STAGE", adAccountId: "act_123", pageId: "456" });
    w.store.put("brands", b);
    const writes: Array<{ path: string; params: URLSearchParams }> = [];
    let counter = 900;
    const meta = new MetaGateway(w.store, w.vault, async (url, init) => {
      const path = new URL(String(url)).pathname;
      const params = new URLSearchParams(String(init?.body ?? ""));
      writes.push({ path, params });
      return Response.json(
        path.endsWith("/customaudiences")
          ? { id: String(++counter) }
          : { success: true },
      );
    });
    const e = new Engine(w.store, w.vault, { meta });
    const run = e.createRun(b.id);
    run.plan = planFor(b);
    const pool = AUDIENCE_POOLS.video_75_30d;
    const seed = (await new TestProduction(w.store, w.vault).draft(b, run))[0]!;
    const video = (index: number, page = b.pageId) =>
      w.store.put("creatives", {
        ...seed,
        id: `video-${index}`,
        videoId: String(10000 + index),
        metaAccountId: b.adAccountId,
        metaPageId: page,
      });
    for (let i = 0; i < 201; i++) video(i);
    video(999, "another-page");
    await e.videoAudience(b, run, pool);
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((x) => JSON.parse(x.params.get("rule")!).length),
      [200, 1],
    );
    assert.deepEqual(e.poolIds(b, pool), ["901", "902"]);
    assert.deepEqual(e.poolIds(b, AUDIENCE_POOLS.warm_union_30d), [
      "901",
      "902",
    ]);
    await e.videoAudience(b, run, pool);
    assert.equal(writes.length, 2, "unchanged rules cause no Meta write");
    video(201);
    await e.videoAudience(b, run, pool);
    assert.equal(writes.length, 3);
    assert.ok(writes[2]!.path.endsWith("/902"));
    assert.equal(JSON.parse(writes[2]!.params.get("rule")!).length, 2);
    b.audienceIds[pool.id] = "777";
    await e.videoAudience(b, run, pool);
    assert.equal(writes.length, 3, "manual audience must not be edited");
    assert.deepEqual(e.poolIds(b, pool), ["777"]);
  } finally {
    w.clean();
  }
});
test("lead pagination resumes across workers and overlaps incremental scans without duplicate delivery", async () => {
  const w = workspace();
  let reopened: Store | undefined;
  try {
    const b = fixture({
      mode: "LIVE",
      adAccountId: "act_123",
      pageId: "456",
      destination: {
        url: "https://example.com",
        pixelId: "123",
        customEventType: "PURCHASE",
        leadFormId: "987",
      },
    });
    w.store.put("brands", b);
    const requests: URL[] = [];
    const fake: typeof fetch = async (url) => {
      const u = new URL(String(url));
      requests.push(u);
      const page = Number(u.searchParams.get("after") ?? 0);
      return Response.json({
        data: [
          {
            id: String(1000 + page),
            created_time: "2026-09-11T00:00:00Z",
            field_data: [{ name: "email", values: ["example@example.com"] }],
          },
        ],
        ...(page < 4
          ? {
              paging: {
                next: `https://graph.facebook.com/v26.0/987/leads?after=${page + 1}&access_token=should-not-persist`,
              },
            }
          : {}),
      });
    };
    const e = new Engine(w.store, w.vault, { fetchImpl: fake });
    assert.equal(await e.syncLeads(b), true);
    assert.equal(w.store.count("leads"), 3);
    reopened = new Store(w.dir);
    const resumed = new Engine(reopened, new Vault(reopened), {
      fetchImpl: fake,
    });
    assert.equal(await resumed.syncLeads(b), false);
    assert.equal(requests[3]!.searchParams.get("after"), "3");
    assert.equal(w.store.count("leads"), 5);
    assert.equal(
      w.store.claim(),
      undefined,
      "collecting without a CRM does not lose the leads",
    );
    assert.equal(await resumed.syncLeads(b), true);
    assert.ok(
      requests[5]!.searchParams.get("filtering")?.includes("time_created"),
    );
    assert.equal(
      w.store.count("leads"),
      5,
      "overlapping pages deduplicate by Meta lead ID",
    );
    assert.ok(
      !String(
        w.store.db
          .prepare("SELECT value FROM settings WHERE key LIKE 'lead-sync:%'")
          .get()?.["value"],
      ).includes("should-not-persist"),
    );
    w.store.enqueuePendingLeads(b.id);
    const first = w.store.claim()!;
    assert.equal(first.kind, "lead");
    w.store.finish(first, Date.now() + 3600000, "CRM unavailable");
    const lead = w.store.get<Lead>("leads", "1001")!;
    w.store.put("leads", { ...lead, delivery: "delivered" });
    w.store.enqueuePendingLeads(b.id);
    assert.equal(
      Number(
        w.store.db.prepare("SELECT due FROM jobs WHERE id=?").get(first.id)?.[
          "due"
        ],
      ) > Date.now(),
      true,
      "rescheduling does not bypass a backoff",
    );
  } finally {
    reopened?.close();
    w.clean();
  }
});
test("lead sync runs for a paused live brand and urgent monitoring takes priority over CRM backlog", async () => {
  const w = workspace();
  try {
    const b = fixture({
      mode: "LIVE",
      adAccountId: "act_123",
      pageId: "456",
      destination: {
        url: "https://example.com",
        pixelId: "123",
        customEventType: "PURCHASE",
        leadFormId: "987",
      },
    });
    w.store.put("brands", b);
    let reads = 0;
    const e = new Engine(w.store, w.vault, {
      fetchImpl: async () => {
        reads++;
        return Response.json({ data: [] });
      },
    });
    await e.tick();
    assert.equal(reads, 1);
    assert.equal(w.store.get<ManagedBrand>("brands", b.id)!.autonomy, false);
    w.store.enqueue("lead", "old", 1);
    w.store.enqueue("monitor", b.id);
    assert.equal(w.store.claim()!.kind, "monitor");
  } finally {
    w.clean();
  }
});
test("persistent jobs preserve monitor cadence and reclaim expired leases", () => {
  const w = workspace();
  try {
    w.store.enqueue("monitor", "nord", 1000);
    const a = w.store.claim(1001)!;
    assert.equal(a.attempt, 1);
    w.store.finish(a, Date.now() + 60000);
    w.store.enqueue("monitor", "nord", Date.now(), false);
    assert.equal(w.store.claim(), undefined);
    w.store.db.prepare("UPDATE jobs SET due=0").run();
    const b = w.store.claim()!;
    assert.equal(b.attempt, 1);
    w.store.db.prepare("UPDATE jobs SET lease_until=0").run();
    const recovered = w.store.claim()!;
    assert.notEqual(b.lease, recovered.lease);
    w.store.finish(b);
    assert.equal(
      w.store.db.prepare("SELECT state FROM jobs").get()?.["state"],
      "running",
    );
  } finally {
    w.clean();
  }
});
test("production reservations are atomic across stores and conservative on interruptions", () => {
  const w = workspace(),
    second = new Store(w.dir);
  try {
    w.store.reserveCharge("one", "nord", "2026-01-01", 7000000, 10);
    assert.throws(
      () => second.reserveCharge("two", "nord", "2026-01-01", 4000000, 10),
      /allowance/,
    );
    second.reserveCharge("one", "nord", "2026-01-01", 7000000, 10);
    assert.equal(w.store.spent("nord", "2026-01-01"), 7000000);
    w.store.settleCharge("one", 2000000);
    second.reserveCharge("two", "nord", "2026-01-01", 4000000, 10);
    assert.equal(w.store.spent("nord", "2026-01-01"), 6000000);
  } finally {
    second.close();
    w.clean();
  }
});
test("vault persists encrypted secrets and never returns plaintext status", () => {
  const w = workspace();
  try {
    w.vault.set("metaToken", "sensitive-test-token-123");
    const row = w.store.db.prepare("SELECT value FROM secrets").get();
    assert.ok(!String(row?.["value"]).includes("sensitive"));
    assert.equal(
      new Vault(w.store).get("metaToken"),
      "sensitive-test-token-123",
    );
    assert.equal(w.vault.status()["metaToken"], true);
    assert.ok(
      !w.vault.redact("bad sensitive-test-token-123").includes("sensitive"),
    );
  } finally {
    w.clean();
  }
});
test("simulation exercises planner, copy, review, publishing, activation and distinct metrics without network", async () => {
  const w = workspace();
  try {
    const never: typeof fetch = async () => {
      throw new Error("Unexpected network call");
    };
    const e = new Engine(w.store, w.vault, {
      fetchImpl: never,
      production: new TestProduction(w.store, w.vault, never),
    });
    w.store.put("brands", fixture({ countries: ["SE"], currency: "SEK" }));
    const run = e.createRun("nord");
    const result = await finish(e, run.id);
    assert.ok(result.stages.every((s) => s.active));
    assert.equal(w.store.list<Creative>("creatives").length, 1);
    assert.equal(w.store.list<Metric>("metrics").length, 14);
    assert.ok(w.store.list<Metric>("metrics").every((m) => m.simulation));
    assert.equal(w.store.spent("nord", nowIso().slice(0, 10)), 0);
    await e.pauseBrand("nord");
    assert.ok(
      w.store
        .list<CampaignRun>("runs")
        .every((r) => r.stages.every((s) => !s.active)),
    );
  } finally {
    w.clean();
  }
});
test("all five funnel plans retain exact daily allocations and generate stage-specific creatives", async () => {
  const w = workspace();
  try {
    const b = fixture({
      spend: {
        dailyBudgetMinor: 2000000,
        maxDailyBudgetMinor: 4000000,
        targetCpaMinor: 1000,
      },
      warmPoolSize: 100000,
      purchasesLast180d: 10000,
      assets: "customers",
    });
    w.store.put("brands", b);
    const e = new Engine(w.store, w.vault, {
      production: new TestProduction(w.store, w.vault),
    });
    for (const p of allPlans(b)) {
      assert.equal(
        p.stages.reduce((s, x) => s + x.dailyBudgetMinor, 0),
        b.spend.dailyBudgetMinor,
      );
      b.funnel = p.templateId;
      w.store.put("brands", b);
      const run = e.createRun(b.id);
      const completed = await finish(e, run.id);
      assert.equal(completed.stages.length, p.stages.length);
      const cs = e.creatives(completed);
      assert.equal(new Set(cs.map((c) => c.stageId)).size, p.stages.length);
      await e.pauseBrand(b.id);
    }
  } finally {
    w.clean();
  }
});
test("Meta creation adopts an ambiguous successful request instead of submitting it twice", async () => {
  const w = workspace();
  try {
    const b = fixture({ mode: "STAGE", adAccountId: "act_123", pageId: "456" });
    let name = "",
      writes = 0;
    const fake: typeof fetch = async (_url, init) => {
      if (init?.method === "POST") {
        writes++;
        name = new URLSearchParams(init.body as string).get("name") ?? "";
        throw new Error("fetch failed");
      }
      return Response.json({ data: [{ id: "999999", name }] });
    };
    const meta = new MetaGateway(w.store, w.vault, fake);
    await assert.rejects(
      meta.create(
        "act_123/campaigns",
        { name: "Example", status: "PAUSED" },
        "test",
        b,
      ),
      /fetch failed/,
    );
    assert.equal(
      await meta.create(
        "act_123/campaigns",
        { name: "Example", status: "PAUSED" },
        "test",
        b,
      ),
      "999999",
    );
    assert.equal(writes, 1);
    assert.equal(
      await meta.create(
        "act_123/campaigns",
        { name: "Example", status: "PAUSED" },
        "test",
        b,
      ),
      "999999",
    );
    assert.equal(writes, 1);
  } finally {
    w.clean();
  }
});
test("all advertised conversion goals build a complete hierarchy", async () => {
  const w = workspace();
  try {
    const e = new Engine(w.store, w.vault, {
      production: new TestProduction(w.store, w.vault),
    });
    for (const goal of [
      "website_purchase",
      "website_lead",
      "instant_form_lead",
      "messenger_lead",
      "whatsapp_conversation",
      "phone_call",
      "catalog_sales",
      "traffic",
      "app_install",
    ]) {
      const b = fixture({
        id: goal.replaceAll("_", "-"),
        archetype: goal,
        destination: {
          url: "https://example.com",
          pixelId: "123456789",
          customEventType: goal === "website_lead" ? "LEAD" : "PURCHASE",
          leadFormId: "987654321",
          phoneNumber: "+14155551234",
          applicationId: "111222333",
          objectStoreUrl: "https://apps.apple.com/us/app/id123456789",
          productSetId: "333222111",
        },
      });
      w.store.put("brands", b);
      const r = await finish(e, e.createRun(b.id).id);
      assert.equal(r.status, "complete", goal);
      await e.pauseBrand(b.id);
    }
  } finally {
    w.clean();
  }
});
test("an uncertain Meta create with no match waits and never blindly retries", async () => {
  const w = workspace();
  try {
    const b = fixture({ mode: "STAGE", adAccountId: "act_123", pageId: "456" });
    let writes = 0;
    const meta = new MetaGateway(w.store, w.vault, async (_url, init) => {
      if (init?.method === "POST") {
        writes++;
        throw new Error("fetch failed");
      }
      return Response.json({ data: [] });
    });
    await assert.rejects(
      meta.create("act_123/campaigns", { status: "PAUSED" }, "uncertain", b),
    );
    await assert.rejects(
      meta.create("act_123/campaigns", { status: "PAUSED" }, "uncertain", b),
      RateLimited,
    );
    assert.equal(writes, 1);
  } finally {
    w.clean();
  }
});
test("late activation cannot overtake an owner pause, and unmanaged objects cannot be changed", async () => {
  const w = workspace();
  try {
    const b = fixture({
      mode: "LIVE",
      autonomy: true,
      adAccountId: "act_123",
      pageId: "456",
    });
    w.store.put("brands", b);
    const sent: string[] = [];
    const meta = new MetaGateway(w.store, w.vault, async (_url, init) => {
      sent.push(String(init?.body));
      return Response.json({ success: true });
    });
    meta.own("999", b, "act_123/campaigns");
    b.autonomy = false;
    w.store.put("brands", b);
    await assert.rejects(meta.status("999", "ACTIVE", b), /paused/);
    await meta.status("999", "PAUSED", b);
    assert.equal(sent.length, 1);
    await assert.rejects(meta.status("123", "PAUSED", b), /outside/);
  } finally {
    w.clean();
  }
});
test("staging stays paused; live repairs replace ads in the same ad set with a bounded lineage", async () => {
  const w = workspace();
  try {
    const sent: Array<{ path: string; params: URLSearchParams }> = [];
    let counter = 10000000000;
    const fake: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      const params = new URLSearchParams(String(init?.body ?? ""));
      if (init?.method === "POST") {
        sent.push({ path, params });
        return Response.json(
          /\/(campaigns|adsets|adcreatives|ads|customaudiences)$/.test(path)
            ? { id: String(++counter) }
            : { success: true },
        );
      }
      return Response.json({ data: [] });
    };
    class FakeMeta extends MetaGateway {
      override async check(b: ManagedBrand) {
        b.account = { adAccountId: b.adAccountId, currency: b.currency };
        this.store.put("brands", b);
        return [
          {
            name: "Injected account",
            severity: "PASS" as const,
            detail: "Test account.",
          },
        ];
      }
    }
    const meta = new FakeMeta(w.store, w.vault, fake),
      e = new Engine(w.store, w.vault, {
        meta,
        production: new TestProduction(w.store, w.vault, fake),
      });
    for (const key of ["openaiKey", "seedanceKey"] as const)
      w.vault.set(key, "test-only-key");
    const staged = fixture({
      mode: "STAGE",
      pageId: "123456",
      adAccountId: "act_123456",
    });
    w.store.put("brands", staged);
    const sr = await finish(e, e.createRun(staged.id).id);
    assert.ok(sr.stages.every((s) => !s.active));
    assert.ok(sent.every((s) => s.params.get("status") !== "ACTIVE"));
    await e.pauseBrand(staged.id);
    const live = fixture({
      mode: "LIVE",
      autonomy: true,
      pageId: "123456",
      adAccountId: "act_123456",
    });
    w.store.put("brands", live);
    const lr = await finish(e, e.createRun(live.id).id);
    assert.ok(lr.stages.every((s) => s.active));
    assert.ok(sent.some((s) => s.params.get("status") === "ACTIVE"));
    const before = sent.filter((s) =>
        /\/(campaigns|adsets)$/.test(s.path),
      ).length,
      stage = lr.stages[0]!,
      ad = stage.adIds[0]!;
    await e.repair(live, lr, stage, ad, {
      global: { COPY_ISSUE: "Remove the unsupported phrase from the ad copy." },
    });
    const repair = w.store.list<CampaignRun>("runs").find((r) => r.repair)!;
    assert.equal(repair.repair?.attempt, 1);
    await finish(e, repair.id);
    assert.equal(
      sent.filter((s) => /\/(campaigns|adsets)$/.test(s.path)).length,
      before,
    );
    const updated = w.store.get<CampaignRun>("runs", lr.id)!;
    assert.equal(updated.stages[0]!.adIds.length, 2);
    assert.equal(updated.stages[0]!.adSetId, stage.adSetId);
    const repairedCreative = e.creatives(
      w.store.get<CampaignRun>("runs", repair.id)!,
    )[0]!;
    assert.equal(repairedCreative.lineageId, repair.repair?.lineageId);
    await e.repair(
      live,
      updated,
      updated.stages[0]!,
      repairedCreative.adIds[0]!,
      {
        placementSpecific: {
          dri_copyright: { COPYRIGHT: "Rights holder complaint." },
        },
      },
    );
    assert.equal(
      w.store.get<{ halted: boolean }>("lineages", repairedCreative.lineageId!)
        ?.halted,
      true,
    );
  } finally {
    w.clean();
  }
});
test("cancelled campaign cannot be revived by a stale worker checkpoint", async () => {
  const w = workspace();
  try {
    w.store.put("brands", fixture());
    const e = new Engine(w.store, w.vault);
    const stale = e.createRun("nord");
    await e.pauseBrand("nord");
    stale.status = "queued";
    w.store.put("runs", stale);
    assert.equal(
      w.store.get<CampaignRun>("runs", stale.id)?.status,
      "cancelled",
    );
    assert.equal(await e.advance(stale.id), undefined);
  } finally {
    w.clean();
  }
});
test("a combined live budget ceiling blocks an additional activation", async () => {
  const w = workspace();
  try {
    const b = fixture();
    w.store.put("brands", b);
    const e = new Engine(w.store, w.vault, {
      production: new TestProduction(w.store, w.vault),
    });
    const first = await finish(e, e.createRun("nord").id);
    const second = {
      ...first,
      id: "second",
      stages: first.stages.map((s) => ({
        ...s,
        active: false,
        dailyBudgetMinor: b.spend.maxDailyBudgetMinor,
      })),
    };
    await assert.rejects(e.activate(b, second), /ceiling/);
  } finally {
    w.clean();
  }
});
test("conversion normalization requires consent, hashes identifiers and preserves event IDs", () => {
  const now = Date.now(),
    data = {
      consent: true,
      event_id: "order-123",
      event_name: "Purchase",
      event_time: Math.floor(now / 1000),
      event_source_url: "https://example.com/thanks",
      value: 79,
      currency: "USD",
      user_data: { em: " PERSON@EXAMPLE.COM ", ph: "+1 (415) 555-1234" },
    };
  const payload = conversionPayload(data, now);
  assert.equal(payload["event_id"], "order-123");
  assert.ok(!JSON.stringify(payload).includes("PERSON"));
  assert.deepEqual(
    payload,
    conversionPayload(
      { ...data, user_data: { em: "person@example.com", ph: "14155551234" } },
      now,
    ),
  );
  assert.throws(
    () => conversionPayload({ ...data, consent: false }, now),
    /consent/,
  );
  assert.throws(() =>
    conversionPayload(
      { ...data, event_time: Math.floor(now / 1000) - 8 * 86400 },
      now,
    ),
  );
});
test("SSRF checks reject private and mapped local address families", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(publicIp(ip), false, ip);
  assert.equal(publicIp("8.8.8.8"), true);
  assert.equal(publicIp("2606:4700:4700::1111"), true);
});
test("CSV export protects against formula injection and escapes cells", () => {
  assert.equal(csv("=cmd()"), '"\'=cmd()"');
  assert.equal(csv('a"b'), '"a""b"');
});
test("brand validation rejects malformed destinations and unknown operating modes", () => {
  assert.throws(() => fixture({ mode: "real" }));
  assert.throws(() =>
    fixture({
      destination: {
        url: "https://127.0.0.1",
        pixelId: "123",
        customEventType: "PURCHASE",
      },
    }),
  );
  assert.throws(() => fixture({ generationDailyUsd: 0 }));
  assert.throws(
    () =>
      fixture({
        archetype: "catalog_sales",
        mode: "LIVE",
        pageId: "123",
        adAccountId: "act_123",
        destination: { productSetId: "123" },
      }),
    /catalogue/,
  );
});
test("reporting restatements replace snapshots instead of double counting", () => {
  const base = {
    id: "1",
    brandId: "b",
    runId: "r",
    adId: "a",
    adSetId: "s",
    date: "2026-01-01",
    observedAt: "2026-01-02",
    spendMinor: 10,
    currency: "USD",
    impressions: 2,
    clicks: 1,
    conversions: 0,
    revenueMinor: 0,
    attribution: "7d_click",
    simulation: false,
    videoViews: 0,
  } satisfies Metric;
  assert.equal(
    latestMetrics([
      base,
      { ...base, id: "2", observedAt: "2026-01-03", spendMinor: 15 },
    ]).reduce((s, x) => s + x.spendMinor, 0),
    15,
  );
});
test("HTTP owner setup, CSRF, simulation, media ranges, secret redaction and logout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-http-"));
  const app = createApp({
    dataDir: dir,
    uiDir: resolve("ui"),
    startWorker: false,
    engineFactory: (s, v) =>
      new Engine(s, v, { production: new TestProduction(s, v) }),
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = "",
    csrf = "";
  const req = async (
    path: string,
    method = "GET",
    data?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        origin,
        cookie,
        "x-csrf-token": csrf,
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  try {
    assert.equal((await req("/api/bootstrap")).status, 401);
    const html = await req("/");
    assert.equal(html.status, 200);
    assert.ok(
      html.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'"),
    );
    assert.equal(
      (
        await req("/api/setup", "POST", {
          token: "wrong",
          password: "a good test password",
        })
      ).status,
      403,
    );
    const setup = await req("/api/setup", "POST", {
      token: setupToken(app.store),
      password: "a good test password",
    });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    csrf = ((await setup.json()) as { csrf: string }).csrf;
    assert.equal(
      (await req("/api/demo", "POST", {}, { "x-csrf-token": "bad" })).status,
      403,
    );
    assert.equal(
      (await req("/api/demo", "POST", {}, { origin: "https://evil.example" }))
        .status,
      403,
    );
    assert.equal(
      (
        await req("/api/setup", "POST", {
          token: setupToken(app.store),
          password: "another password",
        })
      ).status,
      409,
    );
    const demo = await req("/api/demo", "POST", {});
    assert.equal(demo.status, 200);
    const b = ((await demo.json()) as { brand: ManagedBrand }).brand;
    const run = await req(`/api/brands/${b.id}/run`, "POST", {});
    assert.equal(run.status, 202);
    await finish(app.engine, ((await run.json()) as { id: string }).id);
    assert.equal((await req(`/api/brands/${b.id}`, "PUT", b)).status, 409);
    const c = app.store.list<Creative>("creatives")[0]!;
    const range = await req(`/api/media/${c.id}/9x16.mp4`, "GET", undefined, {
      range: "bytes=2-5",
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "2345");
    assert.equal(
      (
        await req(`/api/media/${c.id}/9x16.mp4`, "GET", undefined, {
          range: "bytes=200-300",
        })
      ).status,
      416,
    );
    app.vault.set("metaToken", "private-meta-test-token");
    const boot = await (await req("/api/bootstrap")).text();
    assert.ok(!boot.includes("private-meta-test-token"));
    assert.ok(!boot.includes(dir));
    assert.ok(JSON.parse(boot).metrics.every((m: Metric) => m.simulation));
    // Exercise every view with the real HTTP response shape. No browser or paid services.
    const element = {
      innerHTML: "",
      addEventListener() {},
      focus() {},
      querySelectorAll() {
        return [];
      },
      showModal() {},
      open: false,
    };
    const context = {
      document: {
        querySelector() {
          return element;
        },
        addEventListener() {},
        title: "",
      },
      window: { addEventListener() {}, scrollTo() {} },
      location: { hash: "#overview" },
      setInterval() {},
      setTimeout() {},
      Intl,
      URL,
      Date,
      console,
      fixtureData: JSON.parse(boot),
    };
    const code = readFileSync(resolve("ui/app.js"), "utf8").replace(
      "void init();",
      "",
    );
    runInNewContext(
      code +
        `\nstate.data=fixtureData;state.plans={selected:{templateId:'single_engine',recommendation:{templateId:'single_engine'}},options:[]};for(const [page] of nav){location.hash='#'+page;render();if(!app.innerHTML.includes('<main'))throw Error(page+' did not render');}creativeDetail(state.data.creatives[0].id);brandForm(state.data.brands[0].id);funnelDetail('single_engine');`,
      context,
    );
    assert.equal((await req("/api/logout", "POST", {})).status, 200);
    assert.equal((await req("/api/bootstrap")).status, 401);
    assert.equal((await req(`/api/media/${c.id}/9x16.mp4`)).status, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
