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

export interface GraphNode {
  id: string;
  name?: string;
  [key: string]: unknown;
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
  client(mode: RuntimeMode = "LIVE"): MetaClient {
    return new MetaClient({
      appId: this.vault.get("metaAppId"),
      appSecret: this.vault.get("metaAppSecret"),
      accessToken: this.vault.get("metaToken"),
      mode,
      fetchImpl: this.fetchImpl,
    });
  }
  async get<T>(
    path: string,
    params: Record<string, string> = {},
    adAccountId = "",
  ): Promise<T> {
    const client = this.client();
    return this.scheduler.run(
      {
        lane: "READ",
        adAccountId: adAccountId || "shared",
        headers: () => client.rateLimits.get(adAccountId || "shared"),
      },
      () =>
        client.get<T>(path, params, { adAccountId: adAccountId || "shared" }),
    );
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
  async discover(): Promise<{ accounts: GraphNode[]; pages: GraphNode[] }> {
    const accounts = await this.list("me/adaccounts", {
      fields: "id,name,currency,timezone_name,account_status",
    });
    const pages = await this.list("me/assigned_pages", {
      fields: "id,name,instagram_business_account{id,username}",
    });
    return { accounts, pages };
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
      !this.vault.get("metaToken") ||
      !this.vault.get("metaAppSecret") ||
      !this.vault.get("metaAppId")
    )
      return [
        {
          name: "Meta connection",
          severity: "BLOCK",
          detail: "Connect your Meta app and system user token in Connections.",
        },
      ];
    // Token validation is read-only; never creates or activates anything.
    const token = await checkToken(
      this.client(),
      this.vault.get("metaAppId"),
      this.vault.get("metaToken"),
      this.fetchImpl,
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
      const pages = await this.list("me/assigned_pages", { fields: "id,name" });
      if (!pages.some((p) => p.id === brand.pageId))
        checks.push({
          name: "Facebook Page",
          severity: "BLOCK",
          detail: "This Page is not assigned to the connected system user.",
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
        const client = this.client(mode);
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
    return write;
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
