import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app/server.ts";
import { Engine } from "../src/app/engine.ts";
import { setupToken, digest } from "../src/app/security.ts";
import { metaConnection } from "../src/app/meta-auth.ts";
import { OAuthServices } from "./support/oauth-services.ts";
import { fixture } from "./support/mock-workspace.ts";

const config = { appId: "1234567890", appSecret: "only-a-test-app-secret-123456789", configId: "9876543210" };
async function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "facebook-oauth-test-"));
  const service = new OAuthServices();
  const origin = "https://spend.example.com";
  const app = createApp({ dataDir: dir, uiDir: resolve("ui"), origin, startWorker: false, oauthFetchImpl: service.fetch, engineFactory: (store, vault) => new Engine(store, vault, { fetchImpl: service.fetch }) });
  await new Promise<void>(done => app.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const cookies = new Map<string, string>();
  let csrf = "";
  async function request(path: string, method = "GET", input?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(base + path, { method, redirect: "manual", headers: { Origin: origin, Cookie: [...cookies].map(([k,v])=>`${k}=${v}`).join("; "), "x-csrf-token": csrf, ...(input === undefined ? {} : { "content-type": "application/json" }), ...extra }, ...(input === undefined ? {} : { body: typeof input === "string" ? input : JSON.stringify(input) }) });
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(";"); const i = pair!.indexOf("="); const key = pair!.slice(0,i), val = pair!.slice(i+1);
      if (val) cookies.set(key,val); else cookies.delete(key);
    }
    return response;
  }
  async function start(intent = "setup", extra: Record<string, unknown> = {}) {
    const result = await request("/api/meta/oauth/start", "POST", { intent, ...(intent === "setup" ? { token: setupToken(app.store), config } : {}), ...extra });
    assert.equal(result.status, 200, await result.clone().text());
    return new URL(((await result.json()) as { url: string }).url);
  }
  async function callback(url: URL, params = "code=test-authorization-code") {
    return request(`/api/meta/oauth/callback?state=${url.searchParams.get("state")}&${params}`);
  }
  async function login() {
    const redirect = await callback(await start());
    assert.equal(redirect.headers.get("location"), "/?facebook=connected#connections");
    const session = await (await request("/api/session")).json() as { csrf: string };
    csrf = session.csrf;
  }
  return { app, service, cookies, request, start, callback, login, setCsrf: (v: string) => { csrf=v; }, close: async () => { await app.close(); rmSync(dir,{recursive:true,force:true}); } };
}

test("Facebook owner setup exchanges and verifies tokens server-side and preserves a secret-free session", async () => {
  const w=await workspace();try {
    const authorize=await w.start();
    assert.equal(authorize.origin,"https://www.facebook.com");
    assert.equal(authorize.searchParams.get("response_type"),"code");
    assert.equal(authorize.searchParams.get("config_id"),config.configId);
    assert.equal(authorize.searchParams.get("redirect_uri"),"https://spend.example.com/api/meta/oauth/callback");
    assert.ok(!authorize.toString().includes(config.appSecret));
    const response=await w.callback(authorize);
    assert.equal(response.status,303);
    assert.ok(response.headers.getSetCookie().some(c=>c.startsWith("sc_session=") && /HttpOnly/.test(c) && /Secure/.test(c)));
    const session=await (await w.request("/api/session")).json() as { authenticated:boolean; setupRequired:boolean; facebook:{linked:boolean} };
    assert.equal(session.authenticated,true);assert.equal(session.setupRequired,false);assert.equal(session.facebook.linked,true);
    assert.equal(w.app.vault.get("metaUserToken"),"oauth-long-test-credential");
    const stored=JSON.stringify(w.app.store.db.prepare("SELECT * FROM secrets").all());
    assert.ok(!stored.includes("oauth-long-test-credential"));assert.ok(!stored.includes(config.appSecret));
    const bootstrap=await (await w.request("/api/bootstrap")).text();
    for(const secret of [config.appSecret,"oauth-long-test-credential","oauth-short-test-credential"]) assert.ok(!bootstrap.includes(secret));
    assert.equal(w.app.store.db.prepare("SELECT COUNT(*) AS n FROM oauth_states").get()!["n"],0);
  } finally {await w.close();}
});

test("setup, connect and login starts enforce owner proof and origin",async()=>{
  const w=await workspace();try {
    assert.equal((await w.request("/api/meta/oauth/start","POST",{intent:"setup",token:"wrong",config})).status,403);
    assert.equal((await w.request("/api/meta/oauth/start","POST",{intent:"connect"})).status,401);
    assert.equal((await w.request("/api/meta/oauth/start","POST",{intent:"setup",token:setupToken(w.app.store),config},{Origin:"https://attacker.example"})).status,403);
    await w.login();
    w.setCsrf("invalid");assert.equal((await w.request("/api/meta/oauth/start","POST",{intent:"connect"})).status,403);
    assert.equal((await w.request("/api/setup","POST",{token:setupToken(w.app.store),password:"cannot-take-over-owner"})).status,409);
  } finally {await w.close();}
});

for(const failure of ["wrong-browser","expired-state","cancelled","wrong-app","system-user","expired-token","expired-data-access","invalid-token","profile-mismatch","exchange-rejected","changed-config"] as const) test(`Facebook callback rejects ${failure} without granting workspace access`,async()=>{
  const w=await workspace();try {
    const url=await w.start();
    if(failure==="wrong-browser")w.cookies.set("sc_oauth","x".repeat(43));
    if(failure==="expired-state")w.app.store.db.prepare("UPDATE oauth_states SET expires=1").run();
    if(failure==="wrong-app")w.service.appId="5555555555";
    if(failure==="system-user")w.service.tokenType="SYSTEM_USER";
    if(failure==="expired-token")w.service.expiresAt=1;
    if(failure==="expired-data-access")w.service.dataAccessExpiresAt=1;
    if(failure==="invalid-token")w.service.valid=false;
    if(failure==="profile-mismatch")w.service.profileId="5555555555";
    if(failure==="exchange-rejected")w.service.rejectExchange=true;
    if(failure==="changed-config")w.app.vault.set("metaLoginConfigId","8888888888");
    const response=await w.callback(url,failure==="cancelled"?"error=access_denied&error_description=untrusted-description":"code=test-code");
    assert.match(response.headers.get("location")??"",/^\/\?facebook=error/);
    assert.equal(w.app.facebook.owner(),null);assert.equal(w.app.vault.get("metaUserToken"),"");
    assert.equal((await (await w.request("/api/session")).json() as {authenticated:boolean}).authenticated,false);
    assert.ok(!response.headers.get("location")!.includes("untrusted-description"));
  } finally {await w.close();}
});

test("a consumed authorization cannot be replayed",async()=>{
  const w=await workspace();try {
    const url=await w.start(),secret=w.cookies.get("sc_oauth")!;
    await w.callback(url);const calls=w.service.calls.length;
    w.cookies.set("sc_oauth",secret);
    assert.match((await w.callback(url)).headers.get("location")??"",/^\/\?facebook=error/);
    assert.equal(w.service.calls.length,calls);
  } finally {await w.close();}
});

test("Facebook sign-in is bound to the existing owner, and logout does not disconnect background authorization",async()=>{
  const w=await workspace();try {
    await w.login();
    assert.equal((await w.request("/api/logout","POST",{})).status,200);
    assert.equal(w.app.engine.meta.token(),"oauth-long-test-credential");
    w.service.userId="5555555555";
    assert.match((await w.callback(await w.start("login"))).headers.get("location")??"",/^\/\?facebook=error/);
    assert.equal(w.app.facebook.owner()!.id,"123456789012345");
    w.service.userId="123456789012345";
    assert.equal((await w.callback(await w.start("login"))).headers.get("location"),"/?facebook=connected#connections");
  } finally {await w.close();}
});

test("ending the owner session invalidates an in-flight Facebook connection",async()=>{
  const w=await workspace();try {
    await w.login();const url=await w.start("connect");await w.request("/api/logout","POST",{});
    assert.match((await w.callback(url)).headers.get("location")??"",/^\/\?facebook=error/);
  }finally{await w.close();}
});

test("Page discovery encrypts Page tokens and strips tokens from all browser assets",async()=>{
  const w=await workspace();try {
    await w.login();const response=await w.request("/api/assets"),text=await response.text();
    assert.equal(response.status,200);assert.ok(!text.includes("test-credential"));
    const assets=JSON.parse(text);assert.equal(assets.pages[0].instagram_business_account.id,"777777");
    assert.equal(w.app.vault.pageToken("456789"),"page-test-credential");
    assert.ok(!JSON.stringify(w.app.store.db.prepare("SELECT * FROM page_tokens").all()).includes("page-test-credential"));
    assert.ok(!w.service.calls.some(c=>c.path==="me/assigned_pages"));
    assert.ok(!(await (await w.request("/api/bootstrap")).text()).includes("test-credential"));
  }finally{await w.close();}
});

test("missing Page permission is reported as partial discovery, not invented asset access",async()=>{
  const w=await workspace();try {
    await w.login();w.service.denyPages=true;
    const assets=await (await w.request("/api/assets")).json() as {accounts:unknown[];pages:unknown[];warnings:string[]};
    assert.equal(assets.accounts.length,2);assert.equal(assets.pages.length,0);assert.match(assets.warnings.join(" "),/Page permission/);
  }finally{await w.close();}
});

test("selection rejects inaccessible assets and cannot remove an active brand’s access",async()=>{
  const w=await workspace();try {
    await w.login();
    assert.equal((await w.request("/api/meta/assets/select","POST",{accountIds:["act_999999"],pageIds:["456789"]})).status,403);
    assert.equal((await w.request("/api/meta/assets/select","POST",{accountIds:["act_123456"],pageIds:["456789"]})).status,200);
    const brand=fixture({mode:"LIVE",autonomy:true});w.app.store.put("brands",brand);
    assert.doesNotThrow(()=>w.app.engine.meta.assertSelected(brand));
    assert.equal((await w.request("/api/meta/assets/select","POST",{accountIds:[],pageIds:[]})).status,409);
    brand.autonomy=false;w.app.store.put("brands",brand);
    assert.equal((await w.request("/api/meta/assets/select","POST",{accountIds:[],pageIds:[]})).status,200);
    assert.throws(()=>w.app.engine.meta.assertSelected(brand),/Select this brand/);
  }finally{await w.close();}
});

test("lead forms use their Page authorization while advertising uses the user authorization",async()=>{
  const w=await workspace();try {
    await w.login();await w.request("/api/assets");
    w.app.store.put("brands",fixture({mode:"LIVE",destination:{url:"https://example.com",pixelId:"333333",customEventType:"PURCHASE",leadFormId:"444444"}}));
    const response=await w.request("/api/meta/assets/details?account=act_123456&page=456789");assert.equal(response.status,200);
    const forms=w.service.calls.findLast(c=>c.path==="456789/leadgen_forms")!;
    assert.equal(forms.url.searchParams.get("access_token"),"page-test-credential");
    const pixels=w.service.calls.findLast(c=>c.path==="act_123456/adspixels")!;
    assert.equal(pixels.url.searchParams.get("access_token"),"oauth-long-test-credential");
    assert.equal((await w.request("/api/meta/assets/details?account=act_999999&page=456789")).status,403);
  }finally{await w.close();}
});

test("revocation stops autonomous work and reconnect does not reactivate brands",async()=>{
  const w=await workspace();try {
    await w.login();w.app.store.put("brands",fixture({mode:"LIVE",autonomy:true}));
    w.service.revoked=true;await w.request("/api/assets");
    assert.equal(metaConnection(w.app.store,w.app.vault).status,"reconnect_required");
    assert.equal(w.app.engine.brand("nord").autonomy,false);
    assert.ok(w.app.store.db.prepare("SELECT id FROM jobs WHERE kind='pause'").get());
    w.service.revoked=false;await w.callback(await w.start("login"));
    assert.equal(metaConnection(w.app.store,w.app.vault).status,"connected");
    assert.equal(w.app.engine.brand("nord").autonomy,false);
  }finally{await w.close();}
});

test("stored expiration stops the worker before a new provider call",async()=>{
  const w=await workspace();try {
    await w.login();w.app.store.put("brands",fixture({mode:"LIVE",autonomy:true}));
    w.app.store.setSetting("metaConnection",{...metaConnection(w.app.store,w.app.vault),expiresAt:1});
    const count=w.service.calls.length;w.app.engine.meta.refreshConnectionState();
    assert.equal(w.app.engine.brand("nord").autonomy,false);assert.equal(w.service.calls.length,count);
    assert.throws(()=>w.app.engine.meta.token(),/Reconnect/);
  }finally{await w.close();}
});

test("signed deletion removes Facebook personal data, invalidates sessions, and does not reopen public setup",async()=>{
  const w=await workspace();try {
    await w.login();await w.request("/api/assets");
    const payload=Buffer.from(JSON.stringify({algorithm:"HMAC-SHA256",user_id:w.service.userId,issued_at:Math.floor(Date.now()/1000)})).toString("base64url");
    const signature=createHmac("sha256",config.appSecret).update(payload).digest("base64url");
    assert.equal((await w.request("/api/meta/data-deletion","POST",`signed_request=wrong.${payload}`,{"content-type":"application/x-www-form-urlencoded"})).status,403);
    const response=await w.request("/api/meta/data-deletion","POST",new URLSearchParams({signed_request:`${signature}.${payload}`}).toString(),{"content-type":"application/x-www-form-urlencoded"});
    assert.equal(response.status,200);const result=await response.json() as {confirmation_code:string};
    assert.equal(w.app.facebook.owner(),null);assert.equal(w.app.vault.get("metaUserToken"),"");assert.equal(w.app.vault.pageToken("456789"),"");
    const session=await (await w.request("/api/session")).json() as {authenticated:boolean;setupRequired:boolean};assert.equal(session.authenticated,false);assert.equal(session.setupRequired,false);
    assert.equal((await w.request(`/api/meta/deletion-status?code=${result.confirmation_code}`)).status,200);
    assert.equal((await w.request("/api/meta/deletion-status?code=unknown")).status,404);
    assert.ok(!w.app.store.db.prepare("SELECT * FROM sessions WHERE hash=?").get(digest(w.cookies.get("sc_session")!)));
  }finally{await w.close();}
});

test("privacy, removal instructions and one-time setup are available without authentication",async()=>{
  const w=await workspace();try {for(const path of ["/privacy","/data-deletion","/meta-setup"]){const response=await w.request(path);assert.equal(response.status,200);assert.match(await response.text(),/Spend Control/);}}finally{await w.close();}
});

test("setup-token recovery remains possible after a grant is lost while ads need pausing",async()=>{
  const w=await workspace();try{
    await w.login();w.app.store.put("brands",fixture({mode:"LIVE",autonomy:true}));
    w.app.facebook.forgetUser(w.service.userId);
    w.service.userId="222222222222222";
    const url=await w.start("recover",{token:setupToken(w.app.store)});
    assert.equal((await w.callback(url)).headers.get("location"),"/?facebook=connected#connections");
    assert.equal(w.app.facebook.owner()!.id,w.service.userId);assert.equal(w.app.engine.brand("nord").autonomy,false);
  }finally{await w.close();}
});

test("an old signed removal notification cannot delete a later authorization",async()=>{
  const w=await workspace();try{
    await w.login();const previous=Math.floor(Date.now()/1000)-3600;
    w.app.facebook.forgetUser(w.service.userId,previous);
    assert.equal(w.app.facebook.owner()!.id,w.service.userId);assert.ok(w.app.vault.get("metaUserToken"));
  }finally{await w.close();}
});

test("comment webhooks verify the challenge and exact signed bytes, and inbox mutations require owner CSRF",async()=>{
  const w=await workspace();try{
    w.app.vault.set("metaWebhookVerifyToken","test-verify-token");
    assert.equal((await w.request("/api/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello")).status,403);
    assert.equal(await (await w.request("/api/meta/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=hello")).text(),"hello");
    const raw=JSON.stringify({object:"page",entry:[{id:"456789",changes:[{value:{message:"Café ☕"}}]}]});
    const signature=`sha256=${createHmac("sha256",config.appSecret).update(raw).digest("hex")}`;
    w.app.vault.set("metaAppSecret",config.appSecret);
    assert.equal((await w.request("/api/meta/webhook","POST",raw,{"x-hub-signature-256":signature})).status,200);
    assert.equal((await w.request("/api/meta/webhook","POST",raw+" ",{"x-hub-signature-256":signature})).status,403);
    assert.equal((await w.request("/api/engagement/comments")).status,401);
    await w.login();assert.equal((await w.request("/api/engagement/comments")).status,200);
    assert.equal((await w.request("/api/engagement/comments?offset=-1")).status,400);
    assert.equal((await w.request("/api/engagement/nord","POST",{},{"x-csrf-token":"wrong"})).status,403);
    assert.equal((await w.request("/api/connections","POST",{secrets:{glmKey:"private-test-glm-key",minimaxKey:"private-test-minimax-key"},settings:{}})).status,200);
    const bootstrap=await (await w.request("/api/bootstrap")).text();assert.ok(!bootstrap.includes("private-test-"));
  }finally{await w.close();}
});
