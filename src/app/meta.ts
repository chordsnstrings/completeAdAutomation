import { MetaClient } from "../meta/client.ts";
import { MetaApiError } from "../meta/errors.ts";
import { MetaScheduler, RateLimited } from "../meta/scheduler.ts";
import { parseNextPage } from "../meta/insights.ts";
import { createHash } from "node:crypto";
import { checkAdAccount, checkToken } from "../preflight/checks.ts";
import type { RuntimeMode } from "../meta/client.ts";
import type { Store } from "./store.ts";
import type { Vault } from "./security.ts";
import type { ManagedBrand, Check } from "./types.ts";
import { AppError, DEFAULT_SETTINGS, nowIso } from "./types.ts";
import { timedFetch } from "./network.ts";
import { metaConnection, expiredConnection, invalidateMetaConnection } from "./meta-auth.ts";
import type { MetaSelection } from "./meta-auth.ts";

export interface GraphNode {
  id: string;
  name?: string;
  [key: string]: unknown;
}
export interface MetaAssets {
  accounts: GraphNode[];
  pages: GraphNode[];
  businesses: GraphNode[];
  warnings: string[];
  fetchedAt: string;
}
export class MetaGateway {
  readonly store: Store;
  readonly vault: Vault;
  readonly scheduler = new MetaScheduler({ now: Date.now });
  readonly fetchImpl: typeof fetch;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    store: Store,
    vault: Vault,
    fetchImpl: typeof fetch = timedFetch,
  ) {
    this.store = store;
    this.vault = vault;
    this.fetchImpl = fetchImpl;
  }
  token(allowDisconnected = false): string {
    const connection = metaConnection(this.store, this.vault);
    if (expiredConnection(connection)) invalidateMetaConnection(this.store, this.vault, "Facebook authorization expired. Reconnect to continue.");
    if (!allowDisconnected && (connection.status !== "connected" || expiredConnection(connection)))
      throw new AppError("Reconnect Facebook in Connections to restore access.", 409);
    return connection.method === "oauth" ? this.vault.get("metaUserToken") : connection.method === "manual" ? this.vault.get("metaToken") : "";
  }
  refreshConnectionState(): void {
    if (expiredConnection(metaConnection(this.store, this.vault))) invalidateMetaConnection(this.store, this.vault, "Facebook authorization expired. Reconnect to continue.");
  }
  private credentialFor(path: string, mode: RuntimeMode): string {
    if (mode === "SIMULATE") return "";
    const token = this.token();
    if (metaConnection(this.store, this.vault).method !== "oauth") return token;
    const node = path.replace(/^\//, "").split("/")[0]!;
    const page = this.store.list<ManagedBrand>("brands").find(b => b.pageId === node || b.destination.leadFormId === node)?.pageId ?? node;
    return this.vault.pageToken(page) || token;
  }
  recordAuthError(error: unknown): void {
    // An asset-specific permission denial must not revoke otherwise valid access.
    if (error instanceof MetaApiError && [102, 190, 463, 467].includes(error.code))
      invalidateMetaConnection(this.store, this.vault, "Facebook no longer accepts this authorization. Reconnect to restore access.");
  }
  private handleAuthError(error: unknown): never {
    this.recordAuthError(error);
    throw error;
  }
  private async ensurePageCredential(path: string): Promise<void> {
    if (metaConnection(this.store, this.vault).method !== "oauth") return;
    const node = path.replace(/^\//, "").split("/")[0]!;
    const page = this.store.list<ManagedBrand>("brands").find(b => b.pageId === node || b.destination.leadFormId === node)?.pageId;
    if (page && !this.vault.pageToken(page)) {
      await this.pages();
      if (!this.vault.pageToken(page)) throw new AppError("Reconnect Facebook with access to this Page before using its lead forms or content.", 403);
    }
  }
  client(mode: RuntimeMode = "LIVE", path = ""): MetaClient {
    return new MetaClient({
      appId: this.vault.get("metaAppId"),
      appSecret: this.vault.get("metaAppSecret"),
      accessToken: this.credentialFor(path, mode),
      mode,
      fetchImpl: this.fetchImpl,
    });
  }
  async get<T>(
    path: string,
    params: Record<string, string> = {},
    adAccountId = "",
  ): Promise<T> {
    await this.ensurePageCredential(path);
    const client = this.client("LIVE", path);
    return this.scheduler.run(
      {
        lane: "READ",
        adAccountId: adAccountId || "shared",
        headers: () => client.rateLimits.get(adAccountId || "shared"),
      },
      () =>
        client.get<T>(path, params, { adAccountId: adAccountId || "shared" }),
    ).catch(error => this.handleAuthError(error));
  }
  async list(
    path: string,
    params: Record<string, string> = {},
    adAccountId = "",
  ): Promise<GraphNode[]> {
    const result: GraphNode[] = [];
    let current = path,
      currentParams = { limit: "100", ...params };
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const key = current + JSON.stringify(currentParams);
      if (seen.has(key)) throw new AppError("Meta returned a repeating page.");
      seen.add(key);
      const out = await this.get<{
        data?: GraphNode[];
        paging?: { next?: string };
      }>(current, currentParams, adAccountId);
      result.push(...(out.data ?? []));
      if (!out.paging?.next) return result;
      const next = parseNextPage(out.paging.next);
      current = next.path;
      currentParams = { limit: "100", ...next.params };
    }
    throw new AppError(
      "Meta result exceeded 100 pages. Narrow the request before continuing.",
    );
  }
  async pages(): Promise<GraphNode[]> {
    const connection = metaConnection(this.store, this.vault);
    const oauth = connection.method === "oauth";
    const pages = await this.list(oauth ? "me/accounts" : "me/assigned_pages", {
      fields: `id,name,instagram_business_account{id,username}${oauth ? ",access_token,tasks" : ""}`,
    });
    if (oauth && metaConnection(this.store, this.vault).connectedAt === connection.connectedAt) {
      this.store.transaction(() => {
        this.vault.clearPageTokens();
        for (const page of pages) if (typeof page["access_token"] === "string") this.vault.savePageToken(page.id, page["access_token"]);
      });
    }
    return pages.map(page => publicAsset(page, ["id", "name", "tasks", "instagram_business_account"]));
  }
  /** Comment IDs do not contain their Page ID. Always bind their transport explicitly. */
  async pageRequest<T>(pageId: string, method: "GET" | "POST", path: string, params: Record<string, string>, adAccountId: string, beforePost?: () => void): Promise<T> {
    if (!/^\d+$/.test(pageId) || !/^\d+(?:_\d+)?(?:\/(?:comments|replies|subscribed_apps))?$/.test(path)) throw new AppError("Invalid Page content request.");
    this.token();
    await this.ensurePageCredential(pageId);
    const token = this.vault.pageToken(pageId) || (metaConnection(this.store, this.vault).method === "manual" ? this.token() : "");
    if (!token) throw new AppError("Reconnect Facebook with access to this Page.", 403);
    const client = new MetaClient({ appId: this.vault.get("metaAppId"), appSecret: this.vault.get("metaAppSecret"), accessToken: token, mode: "LIVE", fetchImpl: this.fetchImpl });
    return this.scheduler.run({ lane: method === "GET" ? "READ" : "WRITE", adAccountId, headers: () => client.rateLimits.get(adAccountId) }, () => {
      if (method === "GET") return client.get<T>(path, params, { adAccountId });
      beforePost?.(); return client.post<T>(path, params, { adAccountId });
    }).catch(error => this.handleAuthError(error));
  }
  async discover(): Promise<MetaAssets> {
    const connection = metaConnection(this.store, this.vault);
    const warnings: string[] = [];
    const results = await Promise.allSettled([
      this.list("me/adaccounts", { fields: "id,name,currency,timezone_name,account_status,business{id,name}" }),
      this.pages(),
      connection.method === "oauth" && connection.permissions.includes("business_management")
        ? this.list("me/businesses", { fields: "id,name" }) : Promise.resolve([] as GraphNode[]),
    ]);
    const take = (index: number, label: string, fields: string[]) => {
      const result = results[index]!;
      if (result.status === "rejected") { warnings.push(`${label}: ${this.vault.redact(String(result.reason))}`); return []; }
      return result.value.map(node => publicAsset(node, fields));
    };
    const assets: MetaAssets = {
      accounts: take(0, "Ad accounts", ["id", "name", "currency", "timezone_name", "account_status", "business"]),
      pages: take(1, "Facebook Pages", ["id", "name", "tasks", "instagram_business_account"]),
      businesses: take(2, "Businesses", ["id", "name"]), warnings, fetchedAt: nowIso(),
    };
    const current = metaConnection(this.store, this.vault);
    if (current.status !== "connected") throw new AppError("Facebook access needs to be reconnected.", 409);
    if (current.connectedAt !== connection.connectedAt || current.userId !== connection.userId || current.method !== connection.method)
      throw new AppError("Facebook authorization changed during discovery. Refresh the asset list.", 409);
    if (connection.method === "oauth" && !connection.permissions.includes("business_management")) warnings.push("Business portfolio discovery needs business_management permission. Accounts shared directly with you are still listed.");
    this.store.setSetting("metaAssetCache", assets);
    return assets;
  }
  async assetDetails(accountId: string, pageId: string) {
    if (!/^act_\d+$/.test(accountId) || (pageId && !/^\d+$/.test(pageId))) throw new AppError("Choose a valid ad account and Page.");
    const assets = await this.discover();
    if (!assets.accounts.some(a => a.id === accountId) || (pageId && !assets.pages.some(p => p.id === pageId))) throw new AppError("The selected account or Page is not accessible through this connection.", 403);
    const warnings: string[] = [];
    const read = async (path: string, label: string, fields: string) => {
      try { return (await this.list(path, { fields }, accountId)).map(n => publicAsset(n, fields.split(","))); }
      catch (error) { warnings.push(`${label}: ${this.vault.redact(String(error))}`); return []; }
    };
    const [pixels, instagram, forms, audiences, apps] = await Promise.all([
      read(`${accountId}/adspixels`, "Pixels", "id,name"),
      read(`${accountId}/instagram_accounts`, "Instagram accounts", "id,username"),
      pageId ? read(`${pageId}/leadgen_forms`, "Lead forms", "id,name,status") : Promise.resolve([]),
      read(`${accountId}/customaudiences`, "Audiences", "id,name,subtype"),
      read(`${accountId}/advertisable_applications`, "Apps", "id,name"),
    ]);
    return { pixels, instagram, forms, audiences, apps, warnings };
  }
  assertSelected(brand: ManagedBrand): void {
    if (brand.mode === "SIMULATE" || metaConnection(this.store, this.vault).method !== "oauth") return;
    const selection = this.store.setting<MetaSelection>("metaSelection", { accountIds: [], pageIds: [], updatedAt: "" });
    if (!selection.accountIds.includes(brand.adAccountId) || !selection.pageIds.includes(brand.pageId)) throw new AppError("Select this brand’s ad account and Page in Connections before enabling advertising.");
  }
  async check(brand: ManagedBrand): Promise<Check[]> {
    if (brand.currencyUnitVersion !== 1 && ["COP", "CRC", "HUF", "IDR", "TWD"].includes(brand.currency))
      return [{ name: "Budget units", severity: "BLOCK", detail: "Currency handling has been corrected. Review and save this brand’s daily, maximum, lifetime and target-cost budgets before continuing." }];
    if (brand.mode === "SIMULATE") {
      brand.account = {
        adAccountId: brand.adAccountId,
        currency: brand.currency,
        defaultDsaPayor: "Simulation advertiser",
        defaultDsaBeneficiary: "Simulation advertiser",
      };
      brand.preflight = [
        {
          name: "Simulation",
          severity: "PASS",
          detail:
            "The complete workflow can run without contacting an ad account or paid generator.",
        },
      ];
      brand.lastCheckedAt = nowIso();
      this.store.put("brands", brand);
      return brand.preflight;
    }
    const checks: Check[] = [];
    if (brand.archetype === "phone_call" && !brand.resultActionType)
      checks.push({
        name: "Call measurement",
        severity: brand.mode === "LIVE" ? "BLOCK" : "WARN",
        detail:
          "Set the verified call result action_type for this account in the brand’s advanced settings. Live optimization requires this mapping.",
      });
    if (
      !this.token(true) ||
      !this.vault.get("metaAppSecret") ||
      !this.vault.get("metaAppId")
    )
      return [
        {
          name: "Meta connection",
          severity: "BLOCK",
          detail: "Connect Facebook and choose your assets in Connections.",
        },
      ];
    try { this.assertSelected(brand); this.token(); }
    catch (error) { return [{ name: "Facebook access", severity: "BLOCK", detail: this.vault.redact(String(error)) }]; }
    // Token validation is read-only; never creates or activates anything.
    const token = await checkToken(
      this.client(),
      this.vault.get("metaAppId"),
      this.token(),
      this.fetchImpl,
      metaConnection(this.store, this.vault).method === "oauth",
    );
    checks.push(...token.results);
    if (!token.ok) return checks;
    checks.push(...(await checkAdAccount(this.client(), brand.adAccountId)));
    try {
      const account = await this.get<GraphNode>(
        brand.adAccountId,
        {
          fields:
            "id,currency,timezone_name,default_dsa_payor,default_dsa_beneficiary,spend_cap,amount_spent",
        },
        brand.adAccountId,
      );
      if (account["currency"] !== brand.currency)
        checks.push({
          name: "Currency",
          severity: "BLOCK",
          detail: `The ad account uses ${String(account["currency"])}. Update the brand currency.`,
        });
      else
        checks.push({
          name: "Currency",
          severity: "PASS",
          detail: brand.currency,
        });
      brand.timezone = String(account["timezone_name"] ?? brand.timezone);
      brand.account = {
        adAccountId: brand.adAccountId,
        currency: brand.currency,
        ...(account["default_dsa_payor"]
          ? { defaultDsaPayor: String(account["default_dsa_payor"]) }
          : {}),
        ...(account["default_dsa_beneficiary"]
          ? {
              defaultDsaBeneficiary: String(account["default_dsa_beneficiary"]),
            }
          : {}),
      };
      if (
        Number(account["spend_cap"] ?? 0) <=
        Number(account["amount_spent"] ?? 0)
      )
        checks.push({
          name: "Remaining account allowance",
          severity: "BLOCK",
          detail:
            "The account spending cap has been reached or is not configured.",
        });
      const pages = await this.pages();
      if (!pages.some((p) => p.id === brand.pageId))
        checks.push({
          name: "Facebook Page",
          severity: "BLOCK",
          detail: "This Page is not available to the connected Facebook authorization.",
        });
      else
        checks.push({
          name: "Facebook Page",
          severity: "PASS",
          detail: "Page access confirmed.",
        });
      if (brand.destination.pixelId) {
        const pixels = await this.list(
          `${brand.adAccountId}/adspixels`,
          { fields: "id,name" },
          brand.adAccountId,
        );
        checks.push({
          name: "Pixel",
          severity: pixels.some((p) => p.id === brand.destination.pixelId)
            ? "PASS"
            : "BLOCK",
          detail: pixels.some((p) => p.id === brand.destination.pixelId)
            ? "Pixel access confirmed."
            : "Assign this pixel to the ad account and system user.",
        });
      }
      if (brand.destination.leadFormId) {
        await this.get(brand.destination.leadFormId, {
          fields: "id,name,status",
        });
        checks.push({
          name: "Lead form",
          severity: "PASS",
          detail: "Lead form is reachable.",
        });
      } else if (
        brand.archetype === "instant_form_lead" &&
        brand.privacyPolicyUrl
      )
        checks.push({
          name: "Lead form",
          severity: "WARN",
          detail:
            "A form will be created on your Page using the configured privacy policy.",
        });
      if (brand.catalogCreativeId) {
        const creative = await this.get<{ account_id?: string }>(
          brand.catalogCreativeId,
          { fields: "id,account_id" },
          brand.adAccountId,
        );
        if (
          String(creative.account_id) !== brand.adAccountId.replace("act_", "")
        )
          checks.push({
            name: "Catalogue creative",
            severity: "BLOCK",
            detail: "The catalogue creative must belong to this ad account.",
          });
      }
    } catch (e) {
      checks.push({
        name: "Account assets",
        severity: "BLOCK",
        detail: this.vault.redact(String(e)),
      });
    }
    const current = this.store.get<ManagedBrand>("brands", brand.id);
    const account = brand.account;
    const timezone = brand.timezone;
    if (current) Object.assign(brand, current);
    if (account) brand.account = account;
    brand.timezone = timezone;
    brand.lastCheckedAt = nowIso();
    brand.preflight = checks;
    this.store.put("brands", brand);
    return checks;
  }
  async post<T>(
    path: string,
    params: Record<string, string>,
    brand: ManagedBrand,
    mode = brand.mode,
  ): Promise<T> {
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        const delivery =
          params["status"] === "ACTIVE" ||
          (!/\/(campaigns|adsets)$/.test(path) &&
            (params["daily_budget"] !== undefined ||
              params["lifetime_budget"] !== undefined ||
              params["targeting"] !== undefined));
        if (delivery) {
          const current = this.store.get<ManagedBrand>("brands", brand.id);
          if (
            !current?.autonomy ||
            current.mode !== "LIVE" ||
            this.store.setting("app", DEFAULT_SETTINGS).globalPaused
          )
            throw new AppError("Live delivery has been paused.");
        }
        if (mode !== "SIMULATE" && params["status"] !== "PAUSED") this.assertSelected(brand);
        if (mode !== "SIMULATE") await this.ensurePageCredential(path);
        const client = this.client(mode, path);
        return this.scheduler.run(
          {
            lane: "WRITE",
            adAccountId: brand.adAccountId,
            headers: () => client.rateLimits.get(brand.adAccountId),
          },
          () =>
            client.post<T>(path, params, { adAccountId: brand.adAccountId }),
        );
      });
    this.writes = write;
    return write.catch(error => this.handleAuthError(error));
  }
  /** Exact-name recovery after ambiguous creates. No retry until a complete read proves absence. */
  async create(
    path: string,
    params: Record<string, string>,
    key: string,
    brand: ManagedBrand,
    mode = brand.mode,
  ): Promise<string> {
    const effectKey = `meta:${mode}:${brand.adAccountId}:${key}`;
    const suffix = createHash("sha256")
      .update(effectKey)
      .digest("hex")
      .slice(0, 20);
    const name = `${(params["name"] ?? brand.name).slice(0, 180)} · sc_${suffix}`;
    if (mode === "SIMULATE") return `simulated_${suffix}`;
    if (mode === "VALIDATE") {
      await this.post(path, { ...params, name }, brand, mode);
      return `validated_${suffix}`;
    }
    const old = this.store.effect(effectKey);
    if (old?.state === "done") {
      this.own(String(old.value), brand, path);
      return String(old.value);
    }
    if (old?.state === "pending") {
      const matches = (
        await this.list(path, { fields: "id,name" }, brand.adAccountId)
      ).filter((x) => x.name === name);
      if (matches.length > 1)
        throw new AppError(
          "Duplicate Meta objects found. Publishing is stopped until these are reconciled.",
        );
      if (matches[0]) {
        this.store.finishEffect(effectKey, matches[0].id);
        this.own(matches[0].id, brand, path);
        return matches[0].id;
      }
      // Eventual consistency: an empty scan immediately after a timeout is not proof.
      if (Date.now() - Date.parse(old.updatedAt) < 15 * 60000)
        throw new RateLimited(
          brand.adAccountId,
          15 * 60000,
          "Waiting before reconciling an uncertain write.",
        );
      throw new AppError(
        "A prior Meta create has an uncertain outcome. No duplicate was submitted. Reconcile the operation in Activity before retrying.",
      );
    }
    if (old?.state === "failed") this.store.clearFailedEffect(effectKey);
    this.store.startEffect(effectKey);
    try {
      const result = await this.post<{ id?: string }>(
        path,
        { ...params, name },
        brand,
        mode,
      );
      if (!result.id)
        throw new AppError(
          "Meta accepted a create without returning an ID. Reconciliation is required.",
        );
      this.store.finishEffect(effectKey, result.id);
      this.own(result.id, brand, path);
      return result.id;
    } catch (e) {
      if (
        e instanceof RateLimited ||
        (e instanceof MetaApiError &&
          e.disposition !== "AMBIGUOUS" &&
          e.httpStatus < 500)
      )
        this.store.failEffect(effectKey, this.vault.redact(String(e)));
      throw e;
    }
  }
  own(id: string, brand: ManagedBrand, path: string): void {
    this.store.put("objects", {
      id,
      brandId: brand.id,
      account: brand.adAccountId,
      kind: path.split("/").at(-1) ?? "",
      createdAt: nowIso(),
    });
  }
  async status(
    id: string,
    status: "ACTIVE" | "PAUSED",
    brand: ManagedBrand,
    mode = brand.mode,
  ): Promise<void> {
    if (id.startsWith("simulated_") || id.startsWith("validated_")) return;
    const owned = this.store.get<{ brandId: string; account: string }>(
      "objects",
      id,
    );
    if (
      !owned ||
      owned.brandId !== brand.id ||
      owned.account !== brand.adAccountId
    )
      throw new AppError("This object is outside the managed campaign scope.");
    await this.post(id, { status }, brand, status === "PAUSED" ? "LIVE" : mode);
  }
}

/** Explicit fields only: Page access tokens and provider-only fields never enter API responses. */
function publicAsset(node: GraphNode, fields: string[]): GraphNode {
  const out: GraphNode = { id: String(node.id) };
  for (const key of fields) {
    const value = node[key];
    if (key === "access_token" || value === undefined) continue;
    if (["instagram_business_account", "business"].includes(key) && value && typeof value === "object") {
      const inner = value as GraphNode;
      out[key] = publicAsset(inner, ["id", "name", "username"]);
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (key === "tasks" && Array.isArray(value)) out[key] = value.filter(v => typeof v === "string");
  }
  return out;
}
