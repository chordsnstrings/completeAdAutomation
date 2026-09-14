import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GRAPH_API_VERSION, GRAPH_BASE_URL } from "../meta/version.ts";
import { MetaClient } from "../meta/client.ts";
import type { Store } from "./store.ts";
import { Vault, digest, equal } from "./security.ts";
import { AppError, nowIso } from "./types.ts";
import type { ManagedBrand, CampaignRun } from "./types.ts";
import { timedFetch } from "./network.ts";

export const META_PERMISSIONS = {
  ads_management: "Manage advertising",
  ads_read: "Read advertising results",
  business_management: "Discover business assets",
  pages_show_list: "Find your Facebook Pages",
  pages_read_engagement: "Read Page content",
  pages_manage_ads: "Create Page ads and lead forms",
  leads_retrieval: "Retrieve form enquiries",
  instagram_basic: "Find connected Instagram accounts",
  pages_read_user_content: "Read comments on Facebook Pages",
  pages_manage_engagement: "Reply to Facebook comments",
  pages_manage_metadata: "Receive Page webhook notifications",
  instagram_manage_comments: "Read and reply to Instagram comments",
} as const;

export interface MetaOwner { id: string; appId: string; name: string }
export interface MetaConnection {
  method: "oauth" | "manual" | "none";
  status: "connected" | "reconnect_required" | "disconnected";
  appId: string;
  userId: string;
  name: string;
  permissions: string[];
  expiresAt: number;
  dataAccessExpiresAt: number;
  connectedAt: string;
  reason: string;
}
export interface MetaSelection { accountIds: string[]; pageIds: string[]; updatedAt: string }
interface OAuthFlow {
  intent: "setup" | "login" | "connect" | "recover";
  sessionHash: string;
  appId: string;
  configId: string;
  secretDigest: string;
  redirectUri: string;
}
interface DebugToken {
  is_valid?: boolean;
  app_id?: string;
  user_id?: string;
  type?: string;
  scopes?: string[];
  expires_at?: number;
  data_access_expires_at?: number;
}

export function metaConnection(store: Store, vault: Vault): MetaConnection {
  return store.setting<MetaConnection>("metaConnection", {
    method: vault.get("metaToken") ? "manual" : "none",
    status: vault.get("metaToken") ? "connected" : "disconnected",
    appId: vault.get("metaAppId"), userId: "", name: "", permissions: [],
    expiresAt: 0, dataAccessExpiresAt: 0, connectedAt: "", reason: "",
  });
}
export function expiredConnection(c: MetaConnection): boolean {
  return c.method === "oauth" && [c.expiresAt, c.dataAccessExpiresAt].some(t => t > 0 && t <= Date.now());
}
/** Stop new work locally; retained campaign IDs let queued pauses finish after reconnect. */
export function invalidateMetaConnection(store: Store, vault: Vault, reason: string): void {
  const c = metaConnection(store, vault);
  if (c.status === "reconnect_required") return;
  store.setSetting("metaConnection", { ...c, status: "reconnect_required", reason });
  for (const config of store.list<{ id: string; brandId: string; mode: string }>("engagement")) if (config.mode === "auto") store.put("engagement", { ...config, mode: "review" });
  for (const brand of store.list<ManagedBrand>("brands")) {
    if (brand.mode === "SIMULATE") continue;
    brand.autonomy = false;
    store.put("brands", brand);
    store.enqueue("pause", brand.id);
  }
  store.event("", "error", "Facebook connection needs attention", reason + " New automated work is stopped. Existing Meta delivery may continue until pause requests are confirmed.");
}

export class MetaAuthorization {
  readonly store: Store;
  readonly vault: Vault;
  readonly origin: string;
  readonly fetchImpl: typeof fetch;
  constructor(store: Store, vault: Vault, origin: string, fetchImpl: typeof fetch = timedFetch) {
    this.store = store; this.vault = vault; this.origin = origin; this.fetchImpl = fetchImpl;
  }
  owner(): MetaOwner | null { return this.store.setting<MetaOwner | null>("metaOwner", null); }
  established(): boolean {
    return Boolean(this.owner() || this.store.setting("ownerPassword", "") || this.store.setting("ownerEstablished", false));
  }
  configured(): boolean {
    return Boolean(this.vault.get("metaAppId") && this.vault.get("metaAppSecret") && this.vault.get("metaLoginConfigId"));
  }
  redirectUri(): string {
    if (!this.origin) throw new AppError("Set APP_ORIGIN to this workspace’s public HTTPS address before connecting Facebook.");
    const u = new URL(this.origin);
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
      throw new AppError("Facebook sign-in requires a public HTTPS address.");
    return `${u.origin}/api/meta/oauth/callback`;
  }
  publicStatus() {
    return { configured: this.configured(), linked: Boolean(this.owner()), recoveryPassword: Boolean(this.store.setting("ownerPassword", "")) };
  }
  status() {
    const c = metaConnection(this.store, this.vault);
    return {
      ...c,
      status: expiredConnection(c) ? "reconnect_required" : c.status,
      reason: expiredConnection(c) ? "Facebook authorization has expired. Reconnect to restore access." : c.reason,
      configured: this.configured(), linked: Boolean(this.owner()),
      owner: this.owner()?.name ?? "", recoveryPassword: Boolean(this.store.setting("ownerPassword", "")),
      callbackUrl: this.origin ? `${this.origin}/api/meta/oauth/callback` : "",
      deauthorizationUrl: this.origin ? `${this.origin}/api/meta/deauthorize` : "",
      deletionUrl: this.origin ? `${this.origin}/api/meta/data-deletion` : "",
      webhookUrl: this.origin ? `${this.origin}/api/meta/webhook` : "",
      selection: this.store.setting<MetaSelection>("metaSelection", { accountIds: [], pageIds: [], updatedAt: "" }),
      permissionLabels: META_PERMISSIONS,
    };
  }
  configure(config: { appId?: unknown; appSecret?: unknown; configId?: unknown }): void {
    const id = String(config.appId ?? "").trim();
    const secret = String(config.appSecret ?? "").trim();
    const configId = String(config.configId ?? "").trim();
    if (id && !/^\d{5,40}$/.test(id)) throw new AppError("Enter a valid numeric Meta app ID.");
    if (configId && !/^\d{5,40}$/.test(configId)) throw new AppError("Enter a valid numeric Facebook Login configuration ID.");
    if (secret.length > 500 || (secret && secret.length < 16)) throw new AppError("Enter the Meta app secret from your app dashboard.");
    const owner = this.owner();
    if (owner && id && owner.appId !== id) throw new AppError("This workspace’s Facebook owner is linked to another Meta app. Recover owner access before changing the app.", 409);
    if (id && id !== this.vault.get("metaAppId") && this.store.list<ManagedBrand>("brands").some(b => b.autonomy && b.mode !== "SIMULATE"))
      throw new AppError("Pause connected brands before changing the Meta app.", 409);
    this.store.transaction(() => {
      if (id) this.vault.set("metaAppId", id);
      if (secret) this.vault.set("metaAppSecret", secret);
      if (configId) this.vault.set("metaLoginConfigId", configId);
    });
  }
  start(intent: OAuthFlow["intent"], browserSecret: string, sessionHash = ""): { url: string } {
    if (!this.configured()) throw new AppError("Complete the one-time Meta app setup in Connections first.");
    if (intent === "login" && !this.owner()) throw new AppError("Facebook sign-in is not linked yet. Use owner recovery to connect it.", 403);
    if (intent === "setup" && this.established()) throw new AppError("The workspace already has an owner.", 409);
    const state = randomBytes(32).toString("base64url");
    const flow: OAuthFlow = { intent, sessionHash, appId: this.vault.get("metaAppId"), configId: this.vault.get("metaLoginConfigId"), secretDigest: digest(this.vault.get("metaAppSecret")), redirectUri: this.redirectUri() };
    this.store.db.prepare("DELETE FROM oauth_states WHERE expires<?").run(Date.now());
    this.store.db.prepare("INSERT INTO oauth_states VALUES(?,?,?,?)").run(digest(state), digest(browserSecret), Date.now() + 10 * 60000, JSON.stringify(flow));
    const url = new URL(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`);
    for (const [k, v] of Object.entries({ client_id: flow.appId, redirect_uri: flow.redirectUri, config_id: flow.configId, response_type: "code", state, auth_type: "rerequest" })) url.searchParams.set(k, v);
    return { url: url.toString() };
  }
  private consume(state: string, browserSecret: string): OAuthFlow {
    if (!/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(browserSecret)) throw new AppError("This sign-in request could not be verified. Start again.", 403);
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM oauth_states WHERE hash=?").get(digest(state));
      if (!row || Number(row["expires"]) <= Date.now() || !equal(String(row["browser_hash"]), digest(browserSecret)))
        throw new AppError("This sign-in request expired or belongs to another browser. Start again.", 403);
      this.store.db.prepare("DELETE FROM oauth_states WHERE hash=?").run(digest(state));
      return JSON.parse(String(row["data"])) as OAuthFlow;
    });
  }
  private async request<T>(path: string, params: Record<string, string>, token = ""): Promise<T> {
    const url = new URL(`${GRAPH_BASE_URL}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try { response = await this.fetchImpl(url, { redirect: "error", ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) }); }
    catch { throw new AppError("Facebook could not be reached. Start the connection again.", 502); }
    let data: T & { error?: { code?: number } };
    try { data = await response.json() as typeof data; } catch { throw new AppError("Facebook returned an unreadable authorization response.", 502); }
    if (!response.ok || data.error) throw new AppError(`Facebook did not accept this authorization${data.error?.code ? ` (code ${data.error.code})` : ""}. Check the app configuration and try connecting again.`, 502);
    return data;
  }
  private validateToken(data: DebugToken, appId: string): void {
    if (!data?.is_valid || data.app_id !== appId || !/^\d+$/.test(data.user_id ?? "")) throw new AppError("Facebook could not verify this user and app.", 403);
    if (data.type !== "USER") throw new AppError("Choose a User access token in the Facebook Login for Business configuration. System-user tokens cannot identify the workspace owner.", 403);
    if ([data.expires_at, data.data_access_expires_at].some(t => typeof t === "number" && t > 0 && t * 1000 <= Date.now())) throw new AppError("Facebook returned an expired authorization. Connect again.", 403);
    if (typeof data.expires_at !== "number") throw new AppError("Facebook did not return the authorization lifetime. Connect again.", 403);
  }
  async finish(params: URLSearchParams, browserSecret: string): Promise<MetaOwner> {
    const flow = this.consume(params.get("state") ?? "", browserSecret);
    if (params.has("error")) throw new AppError("Facebook access was not granted. You can connect again whenever you’re ready.", 403);
    const code = params.get("code") ?? "";
    if (!code || code.length > 8192) throw new AppError("Facebook did not return a valid authorization code.", 403);
    if (flow.appId !== this.vault.get("metaAppId") || flow.configId !== this.vault.get("metaLoginConfigId") || flow.secretDigest !== digest(this.vault.get("metaAppSecret")))
      throw new AppError("The Meta connection settings changed during sign-in. Start again.", 409);
    const appSecret = this.vault.get("metaAppSecret");
    const first = await this.request<{ access_token?: string }>("oauth/access_token", { client_id: flow.appId, client_secret: appSecret, redirect_uri: flow.redirectUri, code });
    if (!first.access_token) throw new AppError("Facebook did not return an access token.", 502);
    const short = await this.request<{ data: DebugToken }>("debug_token", { input_token: first.access_token }, `${flow.appId}|${appSecret}`);
    this.validateToken(short.data, flow.appId);
    const exchanged = await this.request<{ access_token?: string }>("oauth/access_token", { grant_type: "fb_exchange_token", client_id: flow.appId, client_secret: appSecret, fb_exchange_token: first.access_token });
    if (!exchanged.access_token) throw new AppError("Facebook did not return an extended authorization.", 502);
    const verified = await this.request<{ data: DebugToken }>("debug_token", { input_token: exchanged.access_token }, `${flow.appId}|${appSecret}`);
    this.validateToken(verified.data, flow.appId);
    if (verified.data.user_id !== short.data.user_id) throw new AppError("Facebook returned inconsistent user identities.", 403);
    const client = new MetaClient({ appId: flow.appId, appSecret, accessToken: exchanged.access_token, mode: "LIVE", fetchImpl: this.fetchImpl });
    let profile: { id: string; name?: string };
    try { profile = await client.get<typeof profile>("me", { fields: "id,name" }); }
    catch { throw new AppError("Facebook could not verify your profile. Reconnect and check the app permissions.", 403); }
    if (profile.id !== verified.data.user_id) throw new AppError("Facebook returned an unexpected account.", 403);
    const owner = { id: profile.id, appId: flow.appId, name: (profile.name || "Workspace owner").slice(0, 200) };
    this.store.transaction(() => {
      const bound = this.owner();
      if (flow.intent === "setup" && this.established()) throw new AppError("Owner setup was already completed in another session.", 409);
      if (flow.intent === "connect" && !this.store.db.prepare("SELECT hash FROM sessions WHERE hash=? AND expires>?").get(flow.sessionHash, Date.now()))
        throw new AppError("Your owner session ended. Sign in and connect again.", 403);
      if (flow.intent === "login" && (!bound || bound.id !== owner.id || bound.appId !== owner.appId))
        throw new AppError("This Facebook account is not the workspace owner.", 403);
      if (bound && (bound.id !== owner.id || bound.appId !== owner.appId) && flow.intent !== "recover")
        throw new AppError("Reconnect using the Facebook account already linked to this workspace.", 403);
      if (flow.intent === "recover") this.store.db.prepare("DELETE FROM sessions").run();
      if (flow.intent === "recover" || !verified.data.scopes?.includes("pages_manage_engagement")) for (const config of this.store.list<{ id: string; brandId: string; mode: string }>("engagement")) if (config.mode === "auto") this.store.put("engagement", { ...config, mode: "review" });
      this.store.setSetting("metaOwner", owner);
      this.store.setSetting("ownerEstablished", true);
      this.vault.set("metaUserToken", exchanged.access_token!);
      if (flow.intent !== "login" || metaConnection(this.store, this.vault).method !== "manual") {
      this.vault.clearPageTokens();
      this.store.setSetting("metaAssetCache", null);
      this.store.setSetting("metaConnection", {
        method: "oauth", status: "connected", appId: flow.appId, userId: owner.id, name: owner.name,
        permissions: verified.data.scopes ?? [], expiresAt: (verified.data.expires_at ?? 0) * 1000,
        dataAccessExpiresAt: (verified.data.data_access_expires_at ?? 0) * 1000, connectedAt: nowIso(), reason: "",
      } satisfies MetaConnection);
      }
      for (const brand of this.store.list<ManagedBrand>("brands")) {
        if (brand.mode !== "SIMULATE" && (flow.intent === "recover" || !["ads_read", "ads_management"].every(p => verified.data.scopes?.includes(p)))) {
          brand.autonomy = false;
          this.store.put("brands", brand);
          this.store.enqueue("pause", brand.id);
        }
        // Reconnecting never re-enables advertising. Retry any pending delivery stop now.
        if (brand.mode !== "SIMULATE" && !brand.autonomy && this.store.list<CampaignRun>("runs", brand.id).some(r => r.stages.some(s => s.active || s.activationPending)))
          this.store.enqueue("pause", brand.id);
      }
      this.store.event("", "success", "Facebook connected", "Owner sign-in and business authorization are ready. Choose the assets this workspace should manage.");
    });
    return owner;
  }
  verifySignedRequest(value: string): { user_id: string; issued_at: number } {
    if (value.length > 16384) throw new AppError("Invalid signed request.", 403);
    const parts = value.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new AppError("Invalid signed request.", 403);
    const signature = Buffer.from(parts[0], "base64url");
    const expected = createHmac("sha256", this.vault.get("metaAppSecret")).update(parts[1]).digest();
    if (!this.vault.get("metaAppSecret") || signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new AppError("Invalid signed request.", 403);
    let data: { algorithm?: string; user_id?: string; issued_at?: number };
    try { data = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as typeof data; } catch { throw new AppError("Invalid signed request.", 403); }
    if (data.algorithm !== "HMAC-SHA256" || !/^\d+$/.test(data.user_id ?? "") || !Number.isFinite(data.issued_at) || typeof data.issued_at !== "number" || data.issued_at <= 0 || data.issued_at > Date.now() / 1000 + 300)
      throw new AppError("Invalid signed request.", 403);
    return { user_id: data.user_id!, issued_at: data.issued_at };
  }
  forgetUser(userId: string, issuedAt = Math.floor(Date.now() / 1000)): void {
    if (this.owner()?.id !== userId && metaConnection(this.store, this.vault).userId !== userId) return;
    // A delayed/replayed removal notification cannot remove a subsequent grant.
    const connectedAt = Date.parse(metaConnection(this.store, this.vault).connectedAt);
    if (Number.isFinite(connectedAt) && issuedAt < Math.floor(connectedAt / 1000)) return;
    invalidateMetaConnection(this.store, this.vault, "Facebook access was removed. Reconnect or stop existing delivery in Meta Ads Manager.");
    this.store.transaction(() => {
      this.vault.delete("metaUserToken");
      this.vault.clearPageTokens();
      this.store.setSetting("metaOwner", null);
      this.store.setSetting("ownerEstablished", true);
      this.store.setSetting("metaAssetCache", null);
      this.store.setSetting("metaSelection", { accountIds: [], pageIds: [], updatedAt: nowIso() });
      this.store.setSetting("metaConnection", { method: "none", status: "disconnected", appId: "", userId: "", name: "", permissions: [], expiresAt: 0, dataAccessExpiresAt: 0, connectedAt: "", reason: "Facebook account information and authorization have been removed." } satisfies MetaConnection);
      this.store.db.prepare("DELETE FROM sessions").run();
      this.store.db.prepare("DELETE FROM oauth_states").run();
      this.store.db.prepare("DELETE FROM documents WHERE collection IN ('leads','conversions','comments','commentThreads','engagement','pageKnowledge')").run();
      this.store.db.prepare("DELETE FROM jobs WHERE kind IN ('lead','lead-sync','conversion','engagement-discover','comment-sync','comment-reply','comment-draft','page-knowledge')").run();
      this.store.db.prepare("DELETE FROM effects WHERE key LIKE 'comment-reply:%'").run();
    });
  }
}
