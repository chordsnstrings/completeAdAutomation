import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app/server.ts";
import { setupToken } from "../src/app/security.ts";
import { Engine } from "../src/app/engine.ts";
import type { Lead } from "../src/app/types.ts";
import { DEFAULT_SETTINGS } from "../src/app/types.ts";
import { fixture, workspace, MockServices, MockMeta, MockProduction } from "./support/mock-workspace.ts";

// These tests exercise the public HTTP integration and signed transport. Every
// provider call is intercepted; an unexpected external request is a test failure.
test("HTTP conversion intake validates consent, deduplicates, retries and exports delivered leads", async () => {
  const dir=mkdtempSync(join(tmpdir(),"feedback-test-")),services=new MockServices();
  const deliveries:Array<{headers:Record<string,string>;body:string}>=[];
  let rejectDelivery=true;
  const app=createApp({dataDir:dir,uiDir:resolve("ui"),startWorker:false,engineFactory:(s,v)=>new Engine(s,v,{
    meta:new MockMeta(s,v,services),production:new MockProduction(s,v,services),
    webhookTransport:async(url,_max,headers,_redirects,body)=>{
      assert.equal(url,"https://crm.example.com/leads");
      deliveries.push({headers:headers??{},body:body??""});
      if(rejectDelivery)throw new Error("CRM temporarily unavailable");
      return {bytes:Buffer.from("ok"),contentType:"text/plain"};
    },
  })});
  await new Promise<void>(r=>app.server.listen(0,"127.0.0.1",r));
  const origin=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie="",csrf="";
  const req=(path:string,data?:unknown,headers:Record<string,string>={})=>fetch(origin+path,{method:data===undefined?"GET":"POST",headers:{origin,cookie,"x-csrf-token":csrf,...(data===undefined?{}:{"content-type":"application/json"}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
  try {
    const setup=await req("/api/setup",{token:setupToken(app.store),password:"disposable-feedback-test-password"});
    assert.equal(setup.status,200);cookie=setup.headers.get("set-cookie")!.split(";")[0]!;csrf=((await setup.json()) as {csrf:string}).csrf;
    const b=fixture({autonomy:false,leadWebhookUrl:"https://crm.example.com/leads"});app.store.put("brands",b);
    for(const key of ["metaToken","metaAppId","metaAppSecret","openaiKey","seedanceKey"] as const)app.vault.set(key,"test-only");
    app.vault.set("conversionWebhookToken","test-conversion-token");app.vault.set("leadWebhookSecret","test-signing-secret");
    const event={brand_id:b.id,consent:true,event_name:"Purchase",event_id:"order-100",event_time:Math.floor(Date.now()/1000),event_source_url:"https://example.com/thank-you",value:59,currency:"USD",user_data:{em:" BUYER@EXAMPLE.COM ",ph:"+1 (415) 555-1234"}};
    const authorization="Bearer test-conversion-token";
    assert.equal((await req("/api/webhooks/conversions",event,{authorization:"Bearer wrong"})).status,401);
    for(const invalid of [{consent:false},{currency:"EUR"},{event_time:0},{user_data:{}},{event_source_url:"http://example.com"}])
      assert.equal((await req("/api/webhooks/conversions",{...event,...invalid},{authorization})).status,400);
    for(let i=0;i<2;i++)assert.equal((await req("/api/webhooks/conversions",event,{authorization})).status,202);
    assert.equal(app.store.count("conversions"),1);
    const saved=app.store.list<{id:string;payload:Record<string,unknown>;sent:boolean}>("conversions")[0]!;
    assert.deepEqual((saved.payload["user_data"] as Record<string,unknown>)["em"],[createHash("sha256").update("buyer@example.com").digest("hex")]);
    let fail=true;services.failure=r=>r.path.endsWith("/events")&&fail?new Error("Response lost after Meta submission"):undefined;
    await assert.rejects(app.engine.sendConversion(saved.id));assert.equal(app.store.get<typeof saved>("conversions",saved.id)!.sent,false);
    fail=false;await app.engine.sendConversion(saved.id);await app.engine.sendConversion(saved.id);
    const conversionCalls=services.requests.filter(r=>r.path.endsWith("/events"));assert.equal(conversionCalls.length,2);
    assert.deepEqual(conversionCalls.map(r=>JSON.parse(r.params["data"]!)[0].event_id),["order-100","order-100"]);
    assert.equal(app.store.get<typeof saved>("conversions",saved.id)!.sent,true);
    b.mode="STAGE";app.store.put("brands",b);assert.equal((await req("/api/webhooks/conversions",{...event,event_id:"order-101"},{authorization})).status,400);
    b.mode="LIVE";app.store.put("brands",b);
    const lead:Lead={id:"lead-1",brandId:b.id,formId:"123",createdAt:new Date().toISOString(),fields:{email:"test@example.com",full_name:"=SUM(1,2)"},delivery:"pending",deliveredAt:""};app.store.put("leads",lead);
    await assert.rejects(app.engine.deliverLead(lead.id));assert.equal(app.store.get<Lead>("leads",lead.id)!.delivery,"pending");
    rejectDelivery=false;await app.engine.deliverLead(lead.id);await app.engine.deliverLead(lead.id);assert.equal(deliveries.length,2);
    for(const item of deliveries){
      assert.equal(item.headers["x-event-id"],lead.id);
      assert.equal(item.headers["x-signature-sha256"],createHmac("sha256","test-signing-secret").update(`${item.headers["x-timestamp"]}.${item.body}`).digest("hex"));
      assert.equal(JSON.parse(item.body).fields.email,"test@example.com");
    }
    const exported=await req("/api/export?kind=leads");assert.equal(exported.status,200);
    const csv=await exported.text();assert.match(csv,/delivered/);assert.match(csv,/'=SUM/);assert.match(csv,/test@example.com/);
    assert.equal((await req("/api/export?kind=leads",undefined,{cookie:""})).status,401);
    const checks=await req("/api/connections/check",{});assert.equal(checks.status,200);assert.ok(services.requests.some(r=>r.path.startsWith("/v1/models")));
    services.failure=r=>r.path.startsWith("/v1/models")?new Error("injected unavailable service"):undefined;
    const unavailable=await req("/api/connections/check",{});assert.equal(unavailable.status,200);assert.match(await unavailable.text(),/BLOCK/);
    app.store.put("metrics",{id:"existing-spend",brandId:b.id,simulation:false});
    for(const update of [{currency:"EUR"},{adAccountId:"act_999999"}]) {
      const changed=await fetch(origin+`/api/brands/${b.id}`,{method:"PUT",headers:{origin,cookie,"x-csrf-token":csrf,"content-type":"application/json"},body:JSON.stringify({...b,...update})});
      assert.equal(changed.status,409);assert.match(await changed.text(),/separate brand/);
    }
  } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});

test("production reservations move only definitive retries into the current day's allowance",()=>{
  const w=workspace();try {
    w.store.reserveCharge("retry","nord","2026-09-11",1000000,1);w.store.startEffect("retry");w.store.failEffect("retry","rejected");
    w.store.reserveCharge("used","nord","2026-09-12",900000,1);
    assert.throws(()=>w.store.reserveCharge("retry","nord","2026-09-12",1000000,1),/allowance/);
    w.store.reserveCharge("retry","nord","2026-09-12",1000000,2);
    assert.equal(w.store.spent("nord","2026-09-11"),0);assert.equal(w.store.spent("nord","2026-09-12"),1900000);
    w.store.startEffect("retry");w.store.reserveCharge("retry","nord","2026-09-13",1000000,2);
    assert.equal(w.store.spent("nord","2026-09-13"),0,"uncertain submission remains on its original day");
  }finally{w.clean();}
});

test("queued targeting changes cannot bypass an owner pause",async()=>{
  const w=workspace();try {
    const b=fixture();w.store.put("brands",{...b,autonomy:false});
    await assert.rejects(w.meta.post("123",{targeting:JSON.stringify({geo_locations:{countries:["US"]}})},b),/paused/);
    assert.equal(w.services.requests.length,0);
    w.store.put("brands",b);w.store.setSetting("app",{...DEFAULT_SETTINGS,globalPaused:true});
    await assert.rejects(w.meta.post("123",{targeting:"{}"},b),/paused/);
    assert.equal(w.services.requests.length,0);
  }finally{w.clean();}
});
