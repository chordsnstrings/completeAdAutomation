import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { fixture, workspace, finish, storedMetrics, png, MockMeta, MockServices } from "./support/mock-workspace.ts";
import { Production } from "../src/app/production.ts";
import { Engine } from "../src/app/engine.ts";
import { MetaGateway } from "../src/app/meta.ts";
import { Store } from "../src/app/store.ts";
import { Vault } from "../src/app/security.ts";
import { VeoProvider } from "../src/generation/veo.ts";
import { currencyOffset, ZERO_DECIMAL_CURRENCIES, AMBIGUOUS_MINOR_UNIT_CURRENCIES } from "../src/meta/publish.ts";
import { planFor } from "../src/app/planner.ts";
import { DEFAULT_SETTINGS } from "../src/app/types.ts";
import type { CampaignRun, ManagedBrand, Decision } from "../src/app/types.ts";
import { FUNNEL_TEMPLATE_IDS } from "../src/funnel/templates.ts";

const goals=["website_purchase","website_lead","instant_form_lead","messenger_lead","whatsapp_conversation","phone_call","catalog_sales","traffic","app_install"];
for (const funnel of FUNNEL_TEMPLATE_IDS) for (const goal of goals) {
  test(`LIVE contract workflow: ${funnel} / ${goal}`,async()=>{
    const w=workspace();
    try {
      const b=fixture({funnel,archetype:goal,creativesPerCycle:1,assets:"customers",warmPoolSize:10000,purchasesLast180d:1000,
        resultActionType:goal==="phone_call"?"onsite_conversion.lead_grouped":"",catalogCreativeId:"9988776655",
        audienceIds:{customer_list_value:"89001",customer_list_all:"89002",page_engagers_365d:"89003",ig_engagers_365d:"89004"},
        destination:{url:"https://example.com",pixelId:"123456789",customEventType:goal==="website_lead"?"LEAD":"PURCHASE",leadFormId:"987654321",phoneNumber:"+14155551234",applicationId:"111222333",objectStoreUrl:"https://apps.apple.com/us/app/id123456789",productSetId:"333222111"}});
      w.store.put("brands",b);
      const run=await finish(w.engine,w.engine.createRun(b.id).id);
      assert.equal(run.status,"complete");assert.equal(run.stages.length,run.plan!.stages.length);
      assert.ok(run.stages.every(s=>s.active&&!s.activationPending));
      assert.equal(run.stages.reduce((n,s)=>n+s.dailyBudgetMinor,0),b.spend.dailyBudgetMinor);
      assert.ok(w.services.requests.some(r=>r.path==="/v1/responses"));
      assert.ok(w.services.requests.some(r=>r.path.endsWith("/contents/generations/tasks")));
      await w.engine.pauseBrand(b.id);
      assert.ok(w.store.get<CampaignRun>("runs",run.id)!.stages.every(s=>!s.active&&!s.activationPending));
      assert.ok(run.stages.every(s=>w.services.nodes.get(s.campaignId)!["status"]==="PAUSED"));
    } finally {w.clean();}
  });
}

test("partial activation compensates every stage and retains a recoverable stopped run",async()=>{
  const w=workspace();try{
    const b=fixture({funnel:"seed_and_harvest",creativesPerCycle:1});w.store.put("brands",b);
    const r=w.engine.createRun(b.id);
    while(w.store.get<CampaignRun>("runs",r.id)!.phase!=="activate") await w.engine.advance(r.id);
    const stage=w.store.get<CampaignRun>("runs",r.id)!.stages[1]!;
    w.services.failure=req=>req.path===stage.campaignId&&req.params["status"]==="ACTIVE"?Response.json({error:{code:100,message:"Injected activation rejection"}},{status:400}):undefined;
    await w.engine.tick();await w.engine.tick();
    const stopped=w.store.get<CampaignRun>("runs",r.id)!;
    assert.equal(stopped.status,"blocked");assert.ok(stopped.stages.every(s=>!s.active&&!s.activationPending));
    assert.ok(stopped.stages.every(s=>w.services.nodes.get(s.campaignId)!["status"]==="PAUSED"));
    w.services.failure=undefined;w.engine.retry(r.id);await finish(w.engine,r.id);
    assert.ok(w.store.get<CampaignRun>("runs",r.id)!.stages.every(s=>s.active));
  }finally{w.clean();}
});

test("rollback attempts all campaigns when one pause fails, and durable priority work finishes recovery",async()=>{
  const w=workspace();try{
    const b=fixture({funnel:"seed_and_harvest",creativesPerCycle:1});w.store.put("brands",b);
    const r=w.engine.createRun(b.id);
    while(w.store.get<CampaignRun>("runs",r.id)!.phase!=="activate") await w.engine.advance(r.id);
    const stages=w.store.get<CampaignRun>("runs",r.id)!.stages;
    w.services.failure=req=>(req.path===stages[1]!.campaignId&&req.params["status"]==="ACTIVE")||(req.path===stages[0]!.campaignId&&req.params["status"]==="PAUSED")?Response.json({error:{code:100,message:"Injected Meta failure"}},{status:400}):undefined;
    await assert.rejects(w.engine.activate(b,w.store.get<CampaignRun>("runs",r.id)!));
    assert.equal(w.engine.brand(b.id).autonomy,false);
    assert.equal(w.services.nodes.get(stages[1]!.campaignId)!["status"],"PAUSED");
    assert.equal(w.store.get<CampaignRun>("runs",r.id)!.stages[0]!.activationPending,true);
    w.services.failure=undefined;await w.engine.tick();
    assert.ok(w.store.get<CampaignRun>("runs",r.id)!.stages.every(s=>!s.active&&!s.activationPending));
  }finally{w.clean();}
});

test("monitor recovers an activation lost across a worker restart before reading Insights",async()=>{
  const w=workspace();try{
    const b=fixture({creativesPerCycle:1});w.store.put("brands",b);
    const r=await finish(w.engine,w.engine.createRun(b.id).id);
    r.status="waiting";r.phase="activate";r.stages[0]!.activationPending=true;r.stages[0]!.active=false;w.store.put("runs",r);
    w.services.requests=[];
    const restarted=new Engine(w.store,w.vault,{meta:w.meta,production:w.production});
    await restarted.monitor(b.id);
    assert.equal(w.services.requests[0]!.params["status"],"PAUSED");
    assert.equal(w.services.nodes.get(r.stages[0]!.campaignId)!["status"],"PAUSED");
  }finally{w.clean();}
});

test("a definitive rejection followed by a lost response cannot submit a third paid text request",async()=>{
  const w=workspace();try{
    const b=fixture();w.store.put("brands",b);const r=w.engine.createRun(b.id),key=`copy:${r.id}:stage:0`;let calls=0;
    const p=new Production(w.store,w.vault,async()=>{calls++;if(calls===1)return Response.json({error:{message:"Rejected"}},{status:400});throw new Error("fetch failed after submission");});
    const send=()=>p.json(b,key,"test",{},{type:"object"});
    await assert.rejects(send());assert.equal(w.store.effect(key)!.state,"failed");
    await assert.rejects(send());assert.equal(w.store.effect(key)!.state,"pending");
    await assert.rejects(send(),/interrupted/);assert.equal(calls,2);
    const other=new Store(w.dir);try{assert.equal(other.startEffect(key),false);}finally{other.close();}
  }finally{w.clean();}
});

for (const provider of ["veo","seedance"] as const) test(`${provider} receives the correct reference representation and detected MIME type`,async()=>{
  const w=workspace();try{
    const b=fixture({productImage:"https://example.com/product.png",creativesPerCycle:1});w.store.put("brands",b);
    const r=w.engine.createRun(b.id);r.plan=planFor(b);const [c]=await w.production.draft(b,r);
    c!.provider=provider;c!.model=provider==="veo"?"veo-3.1-fast-generate-001":"seedance-1-5-pro-251215";
    let sent:Record<string,unknown>|undefined;
    class P extends Production {override provider(){return provider==="veo"?new VeoProvider({projectId:"test-project",storageUri:"gs://test-bucket/out",accessToken:"mock",fetchImpl:async(_u,i)=>{sent=JSON.parse(String(i!.body));return Response.json({name:"mock-operation"});}}):super.provider("seedance");}}
    const p=new P(w.store,w.vault,w.services.fetch,w.services.asset);await p.submit(b,c!);
    if(provider==="veo"){
      const image=(sent!["instances"] as Array<{image:Record<string,unknown>}>)[0]!.image;
      assert.equal(image["mimeType"],"image/png");assert.equal(image["bytesBase64Encoded"],png.toString("base64"));assert.equal(image["gcsUri"],undefined);
    }else{
      const req=w.services.requests.find(req=>req.path.endsWith("/contents/generations/tasks"))!;
      const image=(req.body as {content:Array<{type:string;image_url?:{url:string}}>}).content.find(x=>x.type==="image_url")!;
      assert.equal(image.image_url!.url,b.productImage);
    }
  }finally{w.clean();}
});

test("frontend budget entry and formatting agree with backend units for every supported special currency",()=>{
  const source=readFileSync("ui/app.js","utf8");
  const code=source.slice(source.indexOf("const offset ="),source.indexOf("const num ="));
  const context={state:{data:{currencyRules:{wholeUnits:[...ZERO_DECIMAL_CURRENCIES],unsupported:[...AMBIGUOUS_MINOR_UNIT_CURRENCIES]}},currency:"USD"},Intl};
  const functions=runInNewContext(code+"\n({offset,money})",context) as {offset:(c:string)=>number;money:(n:number,c:string)=>string};
  for(const currency of [...ZERO_DECIMAL_CURRENCIES,"USD","AED","EUR","SEK"]){assert.equal(functions.offset(currency),currencyOffset(currency));assert.ok(functions.money(1000*currencyOffset(currency),currency).includes("1,000"));}
  for(const currency of AMBIGUOUS_MINOR_UNIT_CURRENCIES) assert.throws(()=>functions.offset(currency));
});

test("legacy affected budgets require explicit review before live account checks",async()=>{
  const w=workspace();try{
    const b=fixture({currency:"CRC"});delete b.currencyUnitVersion;
    let calls=0;const meta=new MetaGateway(w.store,w.vault,async()=>{calls++;throw new Error("Must not reach Meta");});
    assert.ok((await meta.check(b)).some(c=>c.severity==="BLOCK"&&c.name==="Budget units"));assert.equal(calls,0);
  }finally{w.clean();}
});

for(const scenario of ["learning","winner","loser","mixed","roas","zero","equivalent"] as const) test(`changing live performance: ${scenario}`,async()=>{
  const w=workspace();try{
    const shift=(new Date().getUTCHours()-8+12)%24-12;
    const b=fixture({timezone:`Etc/GMT${shift>=0?"+":""}${shift}`,spend:{dailyBudgetMinor:100000,maxDailyBudgetMinor:300000,targetCpaMinor:1000,...(scenario==="roas"?{targetRoas:3}:{})}});
    w.store.put("brands",b);const r=await finish(w.engine,w.engine.createRun(b.id).id);
    w.services.setPerformance(r,b,scenario);w.store.put("runs",r);
    await w.engine.monitor(b.id);
    const metrics=storedMetrics(w.store,b.id);assert.equal(metrics.length,56);assert.ok(metrics.every(m=>!m.simulation));
    const decisions=w.store.list<Decision>("decisions",b.id);
    assert.ok(decisions.length>0);
    if(scenario==="learning"||scenario==="zero") assert.ok(decisions.every(d=>d.action==="HOLD"));
    if(scenario==="winner") assert.ok(decisions.some(d=>d.action==="SCALE"&&d.applied));
    if(scenario==="loser") assert.ok(decisions.some(d=>d.action==="PAUSE"&&d.applied));
    if(scenario==="equivalent") assert.ok(decisions.every(d=>d.action==="EQUIVALENT"));
    if(scenario==="mixed") assert.ok(decisions.some(d=>d.action==="KILL"&&d.applied));
    if(scenario==="roas") assert.ok(decisions.some(d=>d.reason.includes("ROAS")&&!d.applied));
    const before=w.store.liveSpend(b.id);await w.engine.monitor(b.id);assert.equal(w.store.liveSpend(b.id),before,"repeated Insights must not double count");
  }finally{w.clean();}
});

for(const scenario of ["lifetime","daily","manual-budget","manual-pause","account-restriction"] as const) test(`delivery stop: ${scenario}`,async()=>{
  const w=workspace();try{
    const b=fixture({creativesPerCycle:1});w.store.put("brands",b);const r=await finish(w.engine,w.engine.createRun(b.id).id);
    w.services.setPerformance(r,b,"winner");w.store.put("runs",r);
    if(scenario==="lifetime"){b.lifetimeLimitMinor=1000;w.store.put("brands",b);}
    if(scenario==="daily") for(const row of w.services.rows) row["spend"]="6000";
    if(scenario==="manual-budget") w.services.nodes.get(r.stages[0]!.campaignId)!["daily_budget"]="9999999";
    if(scenario==="manual-pause") w.services.nodes.get(r.stages[0]!.campaignId)!["status"]="PAUSED";
    if(scenario==="account-restriction") w.services.blockAccount=true;
    if(scenario==="account-restriction") await assert.rejects(w.engine.monitor(b.id),/account check failed/);else await w.engine.monitor(b.id);
    assert.equal(w.engine.brand(b.id).autonomy,false);assert.equal(w.services.nodes.get(r.stages[0]!.campaignId)!["status"],"PAUSED");
  }finally{w.clean();}
});

test("Seed & Harvest builds ready lookalikes once, preserves targeting, and enriches the existing ad set",async()=>{
  const w=workspace();try{
    const b=fixture({funnel:"seed_and_harvest",countries:["US","CA"],creativesPerCycle:1});w.store.put("brands",b);
    const r=await finish(w.engine,w.engine.createRun(b.id).id);b.audienceIds=w.engine.brand(b.id).audienceIds;r.createdAt=new Date(Date.now()-31*86400000).toISOString();w.store.put("runs",r);
    const harvest=r.stages.find(s=>s.stageId==="harvest")!;
    const node=w.services.nodes.get(harvest.adSetId)!;const original=structuredClone(node["targeting"]);
    await w.engine.syncSeedLookalike(b,r,[]);
    const requests=w.services.requests.filter(q=>q.params["lookalike_spec"]?.includes("campaign_conversions"));assert.equal(requests.length,2);
    const targeting=node["targeting"] as Record<string,unknown>;
    assert.deepEqual(targeting["geo_locations"],(original as Record<string,unknown>)["geo_locations"]);
    assert.equal((targeting["custom_audiences"] as unknown[]).length,2);
    const writes=w.services.requests.filter(q=>q.method==="POST").length;
    await w.engine.syncSeedLookalike(b,r,[]);assert.equal(w.services.requests.filter(q=>q.method==="POST").length,writes);
  }finally{w.clean();}
});

test("Seed & Harvest holds immature audiences and stops a weak seed after 30 days",async()=>{
  const w=workspace();try{
    const b=fixture({funnel:"seed_and_harvest",creativesPerCycle:1});w.store.put("brands",b);const r=await finish(w.engine,w.engine.createRun(b.id).id);
    await w.engine.syncSeedLookalike(b,r,[]);assert.equal(b.audienceIds["lookalike_campaign_conversions_3pct"],undefined);
    r.createdAt=new Date(Date.now()-31*86400000).toISOString();
    const audience=b.audienceIds["video_75_90d"]??w.engine.brand(b.id).audienceIds["video_75_90d"]!;
    b.audienceIds=w.engine.brand(b.id).audienceIds;w.services.nodes.get(audience)!["approximate_count_lower_bound"]=300;
    w.store.put("runs",r);await w.engine.syncSeedLookalike(b,r,[]);
    assert.equal(r.stages.find(s=>s.stageId==="seed")!.active,false);assert.equal(r.stages.find(s=>s.stageId==="harvest")!.active,true);
  }finally{w.clean();}
});
