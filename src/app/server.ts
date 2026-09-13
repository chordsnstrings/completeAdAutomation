import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "./store.ts";
import {
  Vault,
  digest,
  equal,
  passwordHash,
  passwordMatches,
  setupToken,
} from "./security.ts";
import { Engine, latestMetrics } from "./engine.ts";
import { AppError, DEFAULT_SETTINGS, SECRET_NAMES, nowIso } from "./types.ts";
import type {
  CampaignRun,
  Creative,
  ManagedBrand,
  Settings,
  Metric,
  Lead,
  Decision,
  Activity,
} from "./types.ts";
import {
  object,
  string,
  validateManagedBrand,
  validateSettings,
} from "./validation.ts";
import { allPlans, planFor } from "./planner.ts";
import { conversionPayload } from "./webhooks.ts";
import { FUNNEL_TEMPLATES, AUDIENCE_POOLS } from "../funnel/templates.ts";
import { ARCHETYPES } from "../meta/objectives.ts";
import { currencyOffset, ZERO_DECIMAL_CURRENCIES, AMBIGUOUS_MINOR_UNIT_CURRENCIES } from "../meta/publish.ts";
import { timedFetch } from "./network.ts";
import { MetaAuthorization, metaConnection } from "./meta-auth.ts";
import type { MetaSelection, MetaConnection } from "./meta-auth.ts";
import type { MetaAssets } from "./meta.ts";

export interface AppOptions {
  dataDir: string;
  uiDir: string;
  origin?: string;
  startWorker?: boolean;
  engineFactory?: (s: Store, v: Vault) => Engine;
  oauthFetchImpl?: typeof fetch;
}
export function createApp(options: AppOptions) {
  const store = new Store(resolve(options.dataDir)),
    vault = new Vault(store),
    engine = options.engineFactory?.(store, vault) ?? new Engine(store, vault);
  const setup = setupToken(store);
  const origin = options.origin ? new URL(options.origin).origin : "";
  const facebook = new MetaAuthorization(store, vault, origin, options.oauthFetchImpl);
  function cookie(req: IncomingMessage, name: string): string {
    return (req.headers.cookie ?? "").split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
  }
  function setCookie(res: ServerResponse, value: string) {
    const previous = res.getHeader("Set-Cookie");
    res.setHeader("Set-Cookie", [...(Array.isArray(previous) ? previous.map(String) : previous ? [String(previous)] : []), value]);
  }
  function redirect(res: ServerResponse, target: string) {
    res.statusCode = 303;
    res.setHeader("Location", target);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.end();
  }
  const attempts = new Map<string, { count: number; until: number }>();
  function throttle(req: IncomingMessage) {
    const key = req.socket.remoteAddress ?? "unknown",
      now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.until < now) {
      entry = { count: 0, until: now + 15 * 60000 };
      attempts.set(key, entry);
    }
    if (++entry.count > 10)
      throw new AppError("Too many attempts. Try again in 15 minutes.", 429);
    if (attempts.size > 10000)
      for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  }
  function session(req: IncomingMessage) {
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("sc_session="))
      ?.slice(11);
    if (!token) return undefined;
    return store.db
      .prepare("SELECT hash,csrf FROM sessions WHERE hash=? AND expires>?")
      .get(digest(token), Date.now());
  }
  function startSession(res: ServerResponse) {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(24).toString("base64url");
    store.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(digest(token), csrf, Date.now() + 7 * 86400000);
    setCookie(res,
      `sc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${origin.startsWith("https:") ? "; Secure" : ""}`,
    );
    return csrf;
  }
  function requireOrigin(req: IncomingMessage) {
    const sent = req.headers.origin;
    const expected = origin || `http://${req.headers.host}`;
    if (sent !== expected)
      throw new AppError("Request origin is not allowed.", 403);
  }
  function auth(req: IncomingMessage, mutate = false) {
    const s = session(req);
    if (!s) throw new AppError("Sign in to continue.", 401);
    if (mutate) {
      requireOrigin(req);
      if (!equal(String(req.headers["x-csrf-token"] ?? ""), String(s["csrf"])))
        throw new AppError("Refresh the page and try again.", 403);
    }
    return s;
  }
  function json(res: ServerResponse, data: unknown, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    if (!String(req.headers["content-type"]).startsWith("application/json"))
      throw new AppError("Use application/json.", 415);
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 512 * 1024) throw new AppError("Request is too large.", 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError("Invalid JSON.");
    }
  }
  function cleanCreative(c: Creative) {
    return {
      ...c,
      file: undefined,
      poster: undefined,
      outputUri: undefined,
      shots: c.shots.map((s) => ({
        ...s,
        file: undefined,
        outputUri: undefined,
      })),
      variants: Object.keys(c.variants),
      media: c.file ? `/api/media/${c.id}/9x16.mp4` : "",
      thumbnail: c.poster ? `/api/media/${c.id}/poster.jpg` : "",
    };
  }
  function bootstrap() {
    const brands = store.list<ManagedBrand>("brands");
    return {
      brands,
      runs: store.list<CampaignRun>("runs", undefined, 300),
      creatives: store
        .list<Creative>("creatives", undefined, 300)
        .map(cleanCreative),
      metrics: latestMetrics(store.list<Metric>("metrics", undefined, 100000)),
      decisions: store.list<Decision>("decisions", undefined, 300),
      activity: store.list<Activity>("activity", undefined, 150),
      settings: engine.settings(),
      connections: vault.status(),
      facebook: facebook.status(),
      metaAssets: store.setting<MetaAssets | null>("metaAssetCache", null),
      engagement: engine.engagement.snapshot(),
      funnels: FUNNEL_TEMPLATES,
      goals: ARCHETYPES,
      audiences: AUDIENCE_POOLS,
      currencyRules: {
        wholeUnits: [...ZERO_DECIMAL_CURRENCIES],
        unsupported: [...AMBIGUOUS_MINOR_UNIT_CURRENCIES],
      },
      leadCount: store.count("leads"),
      productionSpend: Object.fromEntries(
        brands.map((b) => [
          b.id,
          store.spent(
            b.id,
            new Date().toLocaleDateString("en-CA", { timeZone: b.timezone }),
          ) / 1e6,
        ]),
      ),
      worker: {
        enabled: options.startWorker !== false,
        pending: Number(
          store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('running','queued')",
            )
            .get()?.["n"] ?? 0,
        ),
      },
    };
  }
  function hasWork(id: string) {
    return store
      .list<CampaignRun>("runs", id)
      .some(
        (r) =>
          r.stages.some((s) => s.active || s.activationPending) ||
          ["queued", "running", "waiting"].includes(r.status),
      );
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    if (origin.startsWith("https:"))
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const url = new URL(req.url ?? "/", origin || "http://localhost"),
      path = url.pathname,
      method = req.method ?? "GET";
    if (path === "/healthz" && method === "GET") {
      json(res, { ok: true });
      return;
    }
    if (path === "/api/session" && method === "GET") {
      const s = session(req);
      json(res, {
        authenticated: Boolean(s),
        setupRequired: !facebook.established(),
        csrf: s?.["csrf"] ?? "",
        facebook: facebook.publicStatus(),
      });
      return;
    }
    if (path === "/api/meta/webhook" && method === "GET") {
      const verify = vault.get("metaWebhookVerifyToken"), challenge = url.searchParams.get("hub.challenge") ?? "";
      if (!verify || url.searchParams.get("hub.mode") !== "subscribe" || !equal(url.searchParams.get("hub.verify_token") ?? "", verify) || challenge.length > 500) throw new AppError("Invalid webhook verification.", 403);
      res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.end(challenge); return;
    }
    if (path === "/api/meta/webhook" && method === "POST") {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1024 * 1024) throw new AppError("Webhook is too large.", 413); chunks.push(bytes); }
      engine.engagement.webhook(Buffer.concat(chunks), String(req.headers["x-hub-signature-256"] ?? ""));
      json(res, { accepted: true }); return;
    }
    if (path === "/api/meta/oauth/start" && method === "POST") {
      requireOrigin(req);
      throttle(req);
      const o = object(await body(req));
      const intent = String(o["intent"] ?? "login");
      if (!["setup", "login", "connect", "recover"].includes(intent)) throw new AppError("Unknown Facebook connection request.");
      let sessionHash = "";
      if (intent === "connect") {
        sessionHash = String(auth(req, true)["hash"]);
        if (metaConnection(store, vault).method === "manual" && store.list<ManagedBrand>("brands").some(b => b.mode !== "SIMULATE" && (b.autonomy || hasWork(b.id))))
          throw new AppError("Pause real campaign work before switching from a system-user connection to Facebook sign-in.", 409);
      }
      if (intent === "setup" || intent === "recover") {
        if (!equal(string(o["token"], "Workspace setup token", 200, true), setup)) throw new AppError("The workspace setup token is incorrect.", 403);
        if (intent === "setup" && facebook.established()) throw new AppError("This workspace already has an owner.", 409);
        if (o["config"]) facebook.configure(object(o["config"]));
      }
      const browserSecret = randomBytes(32).toString("base64url");
      const result = facebook.start(intent as "setup" | "login" | "connect" | "recover", browserSecret, sessionHash);
      setCookie(res, `sc_oauth=${browserSecret}; HttpOnly; SameSite=Lax; Path=/api/meta/oauth; Max-Age=600${origin.startsWith("https:") ? "; Secure" : ""}`);
      json(res, result);
      return;
    }
    if (path === "/api/meta/oauth/callback" && method === "GET") {
      setCookie(res, `sc_oauth=; HttpOnly; SameSite=Lax; Path=/api/meta/oauth; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`);
      try {
        await facebook.finish(url.searchParams, cookie(req, "sc_oauth"));
        startSession(res);
        redirect(res, "/?facebook=connected#connections");
      } catch (error) {
        const detail = error instanceof AppError ? error.message : "Facebook sign-in could not be completed. Start again.";
        redirect(res, `/?facebook=error&message=${encodeURIComponent(vault.redact(detail).slice(0, 350))}`);
      }
      return;
    }
    if (["/api/meta/deauthorize", "/api/meta/data-deletion"].includes(path) && method === "POST") {
      if (!String(req.headers["content-type"]).startsWith("application/x-www-form-urlencoded")) throw new AppError("Use a signed form request.", 415);
      let raw = "";
      for await (const chunk of req) { raw += String(chunk); if (Buffer.byteLength(raw) > 20000) throw new AppError("Request is too large.", 413); }
      const signed = facebook.verifySignedRequest(new URLSearchParams(raw).get("signed_request") ?? "");
      facebook.forgetUser(signed.user_id, signed.issued_at);
      if (path.endsWith("data-deletion")) {
        const confirmation = randomBytes(24).toString("base64url");
        store.db.prepare("INSERT INTO deletion_requests VALUES(?,?,?)").run(confirmation, nowIso(), "complete");
        json(res, { url: `${origin}/data-deletion?code=${confirmation}`, confirmation_code: confirmation });
      } else json(res, { success: true });
      return;
    }
    if (path === "/api/meta/deletion-status" && method === "GET") {
      const code = url.searchParams.get("code") ?? "";
      if (!/^[\w-]{32}$/.test(code)) throw new AppError("Deletion confirmation not found.", 404);
      const result = store.db.prepare("SELECT status,created_at FROM deletion_requests WHERE code=?").get(code);
      if (!result) throw new AppError("Deletion confirmation not found.", 404);
      json(res, result);
      return;
    }
    if (["/api/setup", "/api/login"].includes(path) && method === "POST") {
      requireOrigin(req);
      throttle(req);
      const o = object(await body(req)),
        password = string(o["password"], "Password", 256, true);
      if (path === "/api/setup") {
        if (facebook.established())
          throw new AppError("This workspace has already been set up.", 409);
        if (!equal(string(o["token"], "Setup token", 200, true), setup))
          throw new AppError("The setup token is incorrect.", 403);
        store.setSetting("ownerPassword", passwordHash(password));
        store.setSetting("ownerEstablished", true);
        store.event(
          "",
          "success",
          "Workspace created",
          "Owner access is ready.",
        );
      } else if (!passwordMatches(password, store.setting("ownerPassword", "")))
        throw new AppError("The password is incorrect.", 401);
      json(res, { csrf: startSession(res) });
      return;
    }
    if (path === "/api/webhooks/conversions" && method === "POST") {
      const token = vault.get("conversionWebhookToken");
      if (
        !token ||
        !equal(String(req.headers.authorization ?? ""), `Bearer ${token}`)
      ) {
        throttle(req);
        throw new AppError("Unauthorized webhook.", 401);
      }
      const o = object(await body(req)),
        brand = engine.brand(string(o["brand_id"], "Brand ID", 60, true));
      if (brand.mode !== "LIVE" || !brand.destination.pixelId)
        throw new AppError("Connect a live brand and its pixel first.");
      const payload = conversionPayload(o);
      if (
        payload["custom_data"] &&
        (payload["custom_data"] as Record<string, unknown>)["currency"] !==
          brand.currency
      )
        throw new AppError("Conversion currency must match the brand account.");
      const id = `${brand.id}:${digest(String(payload["event_id"]))}`;
      if (!store.get("conversions", id)) {
        store.put("conversions", {
          id,
          brandId: brand.id,
          payload,
          sent: false,
          createdAt: nowIso(),
        });
        store.enqueue("conversion", id);
      }
      json(res, { accepted: true, event_id: payload["event_id"] }, 202);
      return;
    }
    if (path.startsWith("/api/")) {
      const s = auth(req, !["GET", "HEAD"].includes(method));
      if (path === "/api/logout" && method === "POST") {
        store.db
          .prepare("DELETE FROM sessions WHERE hash=?")
          .run(String(s["hash"]));
        res.setHeader(
          "Set-Cookie",
          `sc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`,
        );
        json(res, { ok: true });
        return;
      }
      if (path === "/api/bootstrap" && method === "GET") {
        json(res, bootstrap());
        return;
      }
      if (path === "/api/engagement/comments" && method === "GET") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError("Invalid comment page.");
        json(res, engine.engagement.comments(url.searchParams.get("brand") ?? "", url.searchParams.get("status") ?? "all", offset)); return;
      }
      const engagement = /^\/api\/engagement\/([a-z0-9-]+)(?:\/(sync|subscribe))?$/.exec(path);
      if (engagement && method === "POST") {
        const id = engagement[1]!;
        if (engagement[2] === "subscribe") await engine.engagement.subscribe(id);
        else if (engagement[2] === "sync") { engine.brand(id); store.enqueue("engagement-discover", id); for (const t of store.list<{ id: string }>("commentThreads", id)) store.enqueue("comment-sync", t.id); }
        else engine.engagement.save(id, await body(req));
        json(res, engine.engagement.snapshot()); return;
      }
      const comment = /^\/api\/comments\/([a-f0-9]{40})\/(approve|dismiss|draft)$/.exec(path);
      if (comment && method === "POST") {
        if (comment[2] === "approve") engine.engagement.approve(comment[1]!, object(await body(req))["reply"]);
        else if (comment[2] === "draft") engine.engagement.queueDraft(comment[1]!);
        else engine.engagement.dismiss(comment[1]!);
        json(res, { ok: true }); return;
      }
      const knowledge = /^\/api\/knowledge\/([a-f0-9]{40})\/refresh$/.exec(path);
      if (knowledge && method === "POST") {
        const page = store.get<{ brandId: string }>("pageKnowledge", knowledge[1]!);
        if (!page) throw new AppError("Knowledge page not found.", 404);
        engine.engagement.intelligence.config(page.brandId);
        store.enqueue("page-knowledge", knowledge[1]!); json(res, { queued: true }); return;
      }
      if (path === "/api/password" && method === "POST") {
        const o = object(await body(req));
        if (store.setting("ownerPassword", "") &&
          !passwordMatches(
            string(o["current"], "Current password", 256, true),
            store.setting("ownerPassword", ""),
          )
        )
          throw new AppError("Current password is incorrect.");
        store.setSetting(
          "ownerPassword",
          passwordHash(string(o["password"], "New password", 256, true)),
        );
        store.db.prepare("DELETE FROM sessions").run();
        json(res, { csrf: startSession(res) });
        return;
      }
      if (path === "/api/meta/config" && method === "POST") {
        facebook.configure(object(await body(req)));
        json(res, facebook.status());
        return;
      }
      if (path === "/api/meta/disconnect" && method === "POST") {
        await engine.pauseAll();
        if (engine.settings().emergencyPending) throw new AppError("Meta has not confirmed every campaign pause. Credentials are retained so those pauses can finish. Reconnect if necessary, then disconnect again.", 409);
        vault.delete("metaUserToken");
        vault.clearPageTokens();
        store.setSetting("metaConnection", { ...metaConnection(store, vault), method: "none", status: "disconnected", userId: "", name: "", permissions: [], expiresAt: 0, dataAccessExpiresAt: 0, reason: "Advertising access is disconnected. Facebook owner sign-in remains linked." } satisfies MetaConnection);
        store.setSetting("metaAssetCache", null);
        store.event("", "info", "Facebook advertising disconnected", "Managed campaign pauses were confirmed and advertising credentials were removed from the active connection.");
        json(res, { ok: true });
        return;
      }
      if (path === "/api/meta/assets/select" && method === "POST") {
        const input = object(await body(req));
        const strings = (value: unknown) => {
          if (!Array.isArray(value) || value.length > 5000 || value.some(v => typeof v !== "string")) throw new AppError("Choose accounts and Pages from the available list.");
          return [...new Set(value as string[])];
        };
        const accountIds = strings(input["accountIds"]), pageIds = strings(input["pageIds"]);
        const available = await engine.meta.discover();
        if (accountIds.some(id => !available.accounts.some(a => a.id === id)) || pageIds.some(id => !available.pages.some(p => p.id === id)))
          throw new AppError("An account or Page is no longer available. Refresh the list and select again.", 403);
        for (const brand of store.list<ManagedBrand>("brands")) {
          if (brand.mode !== "SIMULATE" && (brand.autonomy || hasWork(brand.id)) && (!accountIds.includes(brand.adAccountId) || !pageIds.includes(brand.pageId)))
            throw new AppError(`Pause ${brand.name} before removing its ad account or Page.`, 409);
        }
        const selection: MetaSelection = { accountIds, pageIds, updatedAt: nowIso() };
        store.setSetting("metaSelection", selection);
        json(res, selection);
        return;
      }
      if (path === "/api/meta/assets/details" && method === "GET") {
        json(res, await engine.meta.assetDetails(url.searchParams.get("account") ?? "", url.searchParams.get("page") ?? ""));
        return;
      }
      if (path === "/api/connections" && method === "POST") {
        const o = object(await body(req));
        const settings = validateSettings(
          o["settings"] ?? {},
          engine.settings(),
        );
        const secrets = object(o["secrets"] ?? {});
        if (secrets["metaUserToken"] || secrets["metaLoginConfigId"]) throw new AppError("Use the Facebook connection flow to configure login credentials.");
        if (facebook.owner() && secrets["metaAppId"] && String(secrets["metaAppId"]) !== vault.get("metaAppId")) throw new AppError("The Facebook owner is linked to the current Meta app.", 409);
        if (secrets["metaToken"] && store.list<ManagedBrand>("brands").some(b => b.mode !== "SIMULATE" && (b.autonomy || hasWork(b.id)))) throw new AppError("Pause real campaign work before replacing the Meta authorization.", 409);
        if (
          store
            .list<CampaignRun>("runs")
            .some((r) => ["running", "queued", "waiting"].includes(r.status))
        )
          throw new AppError(
            "Wait for production to finish or pause it before changing providers.",
            409,
          );
        store.transaction(() => {
          for (const key of SECRET_NAMES) {
            if (secrets[key] !== undefined) {
              const value = string(
                secrets[key],
                key,
                key === "googleServiceAccount" ? 20000 : 5000,
              );
              if (key === "googleServiceAccount" && value) {
                let account;
                try {
                  account = object(JSON.parse(value));
                } catch {
                  throw new AppError(
                    "Google credentials must be a valid service account JSON file.",
                  );
                }
                if (!account["private_key"] || !account["client_email"])
                  throw new AppError(
                    "Google credentials are missing the private key or client email.",
                  );
              }
              vault.set(key, value);
            }
          }
          store.setSetting("app", settings);
          if (secrets["metaToken"]) {
            store.setSetting("metaConnection", { method: "manual", status: "connected", appId: vault.get("metaAppId"), userId: "", name: "System user", permissions: [], expiresAt: 0, dataAccessExpiresAt: 0, connectedAt: nowIso(), reason: "" } satisfies MetaConnection);
            vault.clearPageTokens();
            store.setSetting("metaAssetCache", null);
          }
        });
        store.event(
          "",
          "info",
          "Connections updated",
          "Credentials are encrypted at rest.",
        );
        json(res, { settings, connections: vault.status() });
        return;
      }
      if (path === "/api/connections/check" && method === "POST") {
        const checks = [];
        if (engine.meta.token(true)) {
          try {
            const found = await engine.meta.discover();
            checks.push({
              name: "Meta",
              severity: "PASS",
              detail: `${found.accounts.length} accounts and ${found.pages.length} Pages are accessible.${found.warnings.length ? ` ${found.warnings.join(" ")}` : ""}`,
            });
          } catch (e) {
            checks.push({
              name: "Meta",
              severity: "BLOCK",
              detail: vault.redact(String(e)),
            });
          }
        }
        if (vault.get("openaiKey")) {
          try {
          const r = await engine.production.fetchImpl(
            `https://api.openai.com/v1/models/${encodeURIComponent(engine.settings().textModel)}`,
            { headers: { authorization: `Bearer ${vault.get("openaiKey")}` } },
          );
          checks.push({
            name: "OpenAI",
            severity: r.ok ? "PASS" : "BLOCK",
            detail: r.ok
              ? "Model access confirmed."
              : `Model check returned HTTP ${r.status}.`,
          });
          } catch (error) {
            checks.push({ name: "OpenAI", severity: "BLOCK", detail: vault.redact(String(error)) });
          }
        }
        checks.push({
          name: "Video generation",
          severity: "WARN",
          detail:
            "Paid provider access is verified when the first task is submitted, within the production allowance.",
        });
        json(res, { checks });
        return;
      }
      if (path === "/api/assets" && method === "GET") {
        json(res, await engine.meta.discover());
        return;
      }
      if (path === "/api/brands" && method === "POST") {
        const brand = validateManagedBrand(await body(req));
        if (store.get("brands", brand.id))
          throw new AppError("This brand ID already exists.", 409);
        brand.autonomy = false;
        store.put("brands", brand);
        store.event(brand.id, "success", "Brand added", brand.name);
        json(res, brand, 201);
        return;
      }
      if (path === "/api/demo" && method === "POST") {
        const brand = validateManagedBrand({
          id: "nord-demo",
          name: "NORD Objects",
          archetype: "website_purchase",
          destination: {
            url: "https://example.com",
            pixelId: "000000000000000",
            customEventType: "PURCHASE",
          },
          spend: {
            dailyBudgetMinor: 30000,
            maxDailyBudgetMinor: 60000,
            targetCpaMinor: 6000,
            contributionMarginMinor: 18000,
          },
          claims: {
            substantiated: [
              "Considered objects for everyday living.",
              "Explore the NORD collection.",
            ],
            neverSay: ["Guaranteed results"],
            neverShow: ["People or faces"],
          },
          countries: ["SE"],
          currency: "SEK",
          timezone: "Europe/Stockholm",
          proposition:
            "A simulated homeware brand with simple ceramic objects. This example does not advertise real products.",
          mode: "SIMULATE",
          funnel: "single_engine",
          creativesPerCycle: 1,
          generationDailyUsd: 15,
        });
        if (!store.get("brands", brand.id)) store.put("brands", brand);
        json(res, { brand: engine.brand(brand.id) });
        return;
      }
      const bm =
        /^\/api\/brands\/([a-z0-9-]+)(?:\/(plan|check|autonomy|pause|run|assets|reporting-keys))?$/.exec(
          path,
        );
      if (bm) {
        const brand = engine.brand(bm[1]!),
          action = bm[2];
        if (!action && method === "PUT") {
          if (brand.autonomy || hasWork(brand.id))
            throw new AppError(
              "Pause this brand before editing its campaign settings.",
              409,
            );
          const next = validateManagedBrand(await body(req), brand);
          if ((next.adAccountId !== brand.adAccountId || next.currency !== brand.currency) &&
              (store.list<CampaignRun>("runs", brand.id).some(r => r.mode !== "SIMULATE" && r.stages.length > 0) ||
               store.list<Metric>("metrics", brand.id).some(m => !m.simulation)))
            throw new AppError("This brand has real campaign history. Create a separate brand for another ad account or currency so reporting and spend limits stay accurate.", 409);
          next.autonomy = false;
          store.put("brands", next);
          store.event(brand.id, "info", "Brand updated", next.name);
          json(res, next);
          return;
        }
        if (!action && method === "DELETE") {
          if (brand.autonomy || hasWork(brand.id))
            throw new AppError("Pause this brand before archiving it.", 409);
          if (store.list("runs", brand.id).length)
            throw new AppError(
              "Brands with campaign history are retained for reporting. You can leave this brand paused.",
            );
          store.remove("brands", brand.id);
          for (const collection of ["engagement", "commentThreads", "comments", "pageKnowledge"] as const) for (const item of store.list<{ id: string }>(collection, brand.id)) store.remove(collection, item.id);
          json(res, { ok: true });
          return;
        }
        if (action === "plan" && method === "GET") {
          json(res, { selected: planFor(brand), options: allPlans(brand) });
          return;
        }
        if (action === "check" && method === "POST") {
          json(res, { checks: await engine.meta.check(brand) });
          return;
        }
        if (action === "assets" && method === "GET") {
          json(res, {
            audiences: await engine.meta.list(
              `${brand.adAccountId}/customaudiences`,
              {
                fields:
                  "id,name,approximate_count_lower_bound,operation_status",
              },
              brand.adAccountId,
            ),
            forms: await engine.meta.list(`${brand.pageId}/leadgen_forms`, {
              fields: "id,name,status",
            }),
          });
          return;
        }
        if (action === "reporting-keys" && method === "GET") {
          const rows = await engine.meta.list(
            `${brand.adAccountId}/insights`,
            { fields: "actions", level: "ad", date_preset: "last_30d" },
            brand.adAccountId,
          );
          const keys = [
            ...new Set(
              rows.flatMap((row) =>
                Array.isArray(row["actions"])
                  ? (row["actions"] as Array<{ action_type?: string }>)
                      .map((a) => a.action_type)
                      .filter((x): x is string => Boolean(x))
                  : [],
              ),
            ),
          ].sort();
          json(res, { keys });
          return;
        }
        if (action === "autonomy" && method === "POST") {
          const o = object(await body(req));
          if (o["enabled"] !== true) {
            await engine.pauseBrand(brand.id);
            json(res, { ok: true });
            return;
          }
          if (brand.mode === "STAGE" || brand.mode === "VALIDATE")
            throw new AppError(
              "Staging is a single paused rehearsal. Choose simulation or live mode for ongoing autonomy.",
            );
          if (engine.settings().globalPaused)
            throw new AppError("Resume the workspace first.");
          if (brand.mode === "LIVE") {
            if (
              o["dailyBudgetMinor"] !== brand.spend.dailyBudgetMinor ||
              o["maxDailyBudgetMinor"] !== brand.spend.maxDailyBudgetMinor
            )
              throw new AppError(
                "Review and confirm the current advertising budget.",
              );
            const checks = await engine.meta.check(brand);
            if (checks.some((c) => c.severity === "BLOCK"))
              throw new AppError(
                checks
                  .filter((c) => c.severity === "BLOCK")
                  .map((c) => `${c.name}: ${c.detail}`)
                  .join("; "),
              );
            if (
              !vault.get("openaiKey") ||
              !(engine.settings().provider === "seedance"
                ? vault.get("seedanceKey")
                : vault.get("googleServiceAccount"))
            )
              throw new AppError(
                "Connect OpenAI and the selected video provider.",
              );
          }
          const plan = planFor(brand);
          if (plan.refusal) throw new AppError(plan.refusal);
          brand.autonomy = true;
          store.put("brands", brand);
          store.enqueue("monitor", brand.id);
          store.event(
            brand.id,
            "success",
            "Autonomy enabled",
            `${brand.mode} · Daily budget ${brand.currency} ${(brand.spend.dailyBudgetMinor / currencyOffset(brand.currency)).toFixed(2)}`,
          );
          json(res, { ok: true });
          return;
        }
        if (action === "pause" && method === "POST") {
          await engine.pauseBrand(brand.id);
          json(res, { ok: true });
          return;
        }
        if (action === "run" && method === "POST") {
          json(res, engine.createRun(brand.id), 202);
          return;
        }
      }
      const rm = /^\/api\/runs\/([a-f0-9-]+)\/(retry|pause)$/.exec(path);
      if (rm && method === "POST") {
        if (rm[2] === "retry") engine.retry(rm[1]!);
        else {
          const run = store.get<CampaignRun>("runs", rm[1]!);
          if (!run) throw new AppError("Campaign not found.", 404);
          await engine.pauseBrand(run.brandId);
        }
        json(res, { ok: true });
        return;
      }
      if (path === "/api/workspace/pause" && method === "POST") {
        await engine.pauseAll();
        json(res, {
          ok: !engine.settings().emergencyPending,
          pending: engine.settings().emergencyPending,
        });
        return;
      }
      if (path === "/api/workspace/resume" && method === "POST") {
        if (engine.settings().emergencyPending)
          throw new AppError(
            "Meta pause requests are still pending. Reconnect Meta to finish them first.",
          );
        store.setSetting("app", { ...engine.settings(), globalPaused: false });
        store.event(
          "",
          "info",
          "Workspace resumed",
          "Enable autonomy for each brand when ready.",
        );
        json(res, { ok: true });
        return;
      }
      const media =
        /^\/api\/media\/([a-f0-9-]+)\/(9x16\.mp4|4x5\.mp4|1x1\.mp4|poster\.jpg|contact\.jpg)$/.exec(
          path,
        );
      if (media && ["GET", "HEAD"].includes(method)) {
        if (!store.get("creatives", media[1]!))
          throw new AppError("Creative not found.", 404);
        serveFile(req, res, join(store.dir, "media", media[1]!, media[2]!));
        return;
      }
      if (path === "/api/export" && method === "GET") {
        const kind = url.searchParams.get("kind") ?? "metrics",
          brandId = url.searchParams.get("brand") || undefined;
        let rows: Record<string, unknown>[];
        if (kind === "metrics")
          rows = latestMetrics(
            store.list<Metric>("metrics", brandId, 100000),
          ).map((m) => ({ ...m }));
        else if (kind === "leads")
          rows = store.list<Lead>("leads", brandId, -1).map((l) => ({
            id: l.id,
            brand: l.brandId,
            createdAt: l.createdAt,
            delivery: l.delivery,
            ...l.fields,
          }));
        else throw new AppError("Unknown export.");
        const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${kind}.csv"`,
        );
        res.end(
          "\uFEFF" +
            [
              keys.map(csv).join(","),
              ...rows.map((row) => keys.map((k) => csv(row[k])).join(",")),
            ].join("\r\n"),
        );
        return;
      }
      throw new AppError("Route not found.", 404);
    }
    if (
      ["GET", "HEAD"].includes(method) &&
      ["/", "/app.html", "/app.js", "/public.js", "/app.css", "/mark.svg"].includes(path)
    ) {
      serveFile(
        req,
        res,
        join(options.uiDir, path === "/" ? "app.html" : path.slice(1)),
      );
      return;
    }
    if (["GET", "HEAD"].includes(method) && ["/privacy", "/data-deletion", "/meta-setup"].includes(path)) {
      serveFile(req, res, join(options.uiDir, `${path.slice(1)}.html`));
      return;
    }
    throw new AppError("Page not found.", 404);
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = e instanceof AppError ? e.status : 502;
      const message = vault.redact(e instanceof Error ? e.message : String(e));
      json(res, { error: message }, status);
    });
  });
  server.requestTimeout = 70000;
  server.headersTimeout = 15000;
  if (options.startWorker !== false) engine.start();
  return {
    server,
    store,
    vault,
    engine,
    facebook,
    close: async () => {
      engine.stop();
      await new Promise<void>((done) => server.close(() => done()));
      await engine.drain();
      store.close();
    },
  };
}
export function csv(value: unknown): string {
  let v = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g, '""') + '"';
}
function serveFile(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!existsSync(file) || !statSync(file).isFile())
    throw new AppError("File is not ready.", 404);
  const size = statSync(file).size;
  res.setHeader(
    "Content-Type",
    file.endsWith(".mp4")
      ? "video/mp4"
      : file.endsWith(".jpg")
        ? "image/jpeg"
        : file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css; charset=utf-8"
            : file.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html; charset=utf-8",
  );
  res.setHeader("Accept-Ranges", "bytes");
  let start = 0,
    end = size - 1;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.setHeader("Content-Length", Math.max(0, end - start + 1));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
