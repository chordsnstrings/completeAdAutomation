import { META_PERMISSIONS } from "../../src/app/meta-auth.ts";

/** Injectable Meta responses. No transport can reach the network. */
export class OAuthServices {
  userId = "123456789012345";
  profileId = "";
  appId = "1234567890";
  tokenType = "USER";
  expiresAt = Math.floor(Date.now() / 1000) + 60 * 86400;
  dataAccessExpiresAt = Math.floor(Date.now() / 1000) + 90 * 86400;
  permissions: string[] = Object.keys(META_PERMISSIONS);
  valid = true;
  rejectExchange = false;
  denyPages = false;
  revoked = false;
  calls: Array<{ path: string; url: URL; init: RequestInit | undefined }> = [];
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.facebook.com") throw new Error("Unexpected external request blocked by OAuth test transport.");
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    this.calls.push({ path, url, init });
    if (path === "oauth/access_token") {
      if (this.rejectExchange) return Response.json({ error: { code: 100 } }, { status: 400 });
      return Response.json({ access_token: url.searchParams.has("grant_type") ? "oauth-long-test-credential" : "oauth-short-test-credential", expires_in: 60 * 86400 });
    }
    if (path === "debug_token") return Response.json({ data: { is_valid: this.valid, app_id: this.appId, type: this.tokenType, user_id: this.userId, expires_at: this.expiresAt, data_access_expires_at: this.dataAccessExpiresAt, scopes: this.permissions } });
    if (this.revoked) return Response.json({ error: { code: 190, message: "Test authorization revoked" } }, { status: 400 });
    if (path === "me") return Response.json({ id: this.profileId || this.userId, name: "Alex Morgan" });
    if (path === "me/adaccounts") return Response.json({ data: [{ id: "act_123456", name: "NORD · Main account", currency: "USD", timezone_name: "America/New_York", account_status: 1, business: { id: "888888", name: "NORD Studio" } }, { id: "act_222222", name: "NORD · UAE", currency: "AED", timezone_name: "Asia/Dubai", account_status: 1 }] });
    if (path === "me/accounts" || path === "me/assigned_pages") {
      if (this.denyPages) return Response.json({ error: { code: 200, message: "Page permission was not granted" } }, { status: 403 });
      return Response.json({ data: [{ id: "456789", name: "NORD Objects", tasks: ["ADVERTISE", "ANALYZE", "MODERATE"], access_token: "page-test-credential", instagram_business_account: { id: "777777", username: "nord.objects", access_token: "nested-test-credential" } }] });
    }
    if (path === "me/businesses") return Response.json({ data: [{ id: "888888", name: "NORD Studio" }] });
    if (/adspixels$/.test(path)) return Response.json({ data: [{ id: "333333", name: "NORD website dataset" }] });
    if (/instagram_accounts$/.test(path)) return Response.json({ data: [{ id: "777777", username: "nord.objects" }] });
    if (/leadgen_forms$/.test(path)) return Response.json({ data: [{ id: "444444", name: "NORD enquiries", status: "ACTIVE" }] });
    if (/customaudiences$/.test(path)) return Response.json({ data: [{ id: "555555", name: "Website visitors", subtype: "WEBSITE" }] });
    if (/advertisable_applications$/.test(path)) return Response.json({ data: [] });
    if (/act_\d+$/.test(path)) return Response.json({ id: path, name: "NORD", currency: "USD", timezone_name: "America/New_York", spend_cap: "1000000", amount_spent: "1000", account_status: 1 });
    if (init?.method === "POST") return Response.json({ success: true, id: "999999" });
    throw new Error(`Unexpected Meta OAuth test request: ${path}`);
  };
}
