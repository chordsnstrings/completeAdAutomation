import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app/server.ts";
import { setupToken } from "../../src/app/security.ts";
import { Engine } from "../../src/app/engine.ts";
import type { CampaignRun, ManagedBrand, Settings, Creative } from "../../src/app/types.ts";
import { DEFAULT_SETTINGS } from "../../src/app/types.ts";
import { MockServices, MockMeta, MockProduction, fixture, finish } from "./mock-workspace.ts";
import { EngagementServices } from "./engagement-services.ts";
import type { AdComment, CommentThread } from "../../src/app/engagement.ts";
import type { PageKnowledge } from "../../src/app/page-intelligence.ts";
import { META_PERMISSIONS, invalidateMetaConnection } from "../../src/app/meta-auth.ts";

// Explicitly disposable browser fixture. No production database, credentials, worker,
// or provider transport is used. Authentication itself is tested over the real API;
// the local proxy supplies that test session to exercise authenticated UI workflows.
if (process.env["SC_ENABLE_QA"] !== "1") throw new Error("This test fixture requires SC_ENABLE_QA=1.");
const dir=mkdtempSync(join(tmpdir(),"spend-browser-test-"));
const services=new MockServices();services.mediaDir=resolve(process.argv[2]??"../workflow-evidence/media");
const engagementServices=new EngagementServices(), workflowFetch=services.fetch;
services.fetch=async(input,init)=>{
  const url=new URL(String(input)),path=url.pathname.replace(/^\/v\d+\.\d+\//,"");
  if(url.hostname === "api.z.ai" || url.hostname === "api.minimax.io" && path.startsWith("/v1/") || ["me/adaccounts","me/accounts","me/assigned_pages","me/businesses"].includes(path)||/adspixels$|instagram_accounts$|leadgen_forms$|advertisable_applications$/.test(path)||/\/(comments|replies|subscribed_apps)$/.test(path)||engagementServices.nodes.has(path)||(path==="act_123456/ads"&&url.searchParams.get("fields")?.includes("effective_object_story_id")))return engagementServices.fetch(input,init);
  return workflowFetch(input,init);
};
const origin="http://terminal.local:4173";
const app=createApp({dataDir:dir,uiDir:resolve("ui"),origin,startWorker:false,
  oauthFetchImpl:engagementServices.oauth.fetch,
  engineFactory:(s,v)=>new Engine(s,v,{meta:new MockMeta(s,v,services),production:new MockProduction(s,v,services),fetchImpl:services.fetch,pageTransport:engagementServices.page})});
await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));
const upstream=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
let cookie="",csrf="";const password=randomBytes(32).toString("base64url");
async function api(path:string,method="GET",body?:unknown) {
  const response=await fetch(upstream+path,{method,headers:{Origin:origin,Cookie:cookie,"x-csrf-token":csrf,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json() as Record<string,unknown>;
  if(!response.ok)throw new Error(JSON.stringify(data));
  if(response.headers.get("set-cookie"))cookie=response.headers.get("set-cookie")!.split(";")[0]!;
  if(typeof data.csrf==="string")csrf=data.csrf;
  return data;
}
const proxy=createServer(async(req,res)=>{
  try{
    const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value&&!["host","connection","content-length"].includes(key))headers.set(key,Array.isArray(value)?value.join(","):value);
    headers.delete("cookie");if(cookie)headers.set("cookie",cookie);
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    const response=await fetch(upstream+(req.url??"/"),{method:req.method??"GET",headers,...(chunks.length?{body:new Uint8Array(Buffer.concat(chunks))}:{})});
    res.statusCode=response.status;response.headers.forEach((value,key)=>{if(!["transfer-encoding","content-encoding","content-length","connection"].includes(key))res.setHeader(key,value);});
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(502,{"content-type":"text/plain"});res.end(String(error));}
});
await new Promise<void>(resolve=>proxy.listen(4173,"0.0.0.0",resolve));
console.log(JSON.stringify({ready:true,origin,isolated:true,worker:false}));
let current="";
async function command(input:Record<string,unknown>) {
  const action=String(input["action"]);
  if(action==="studio") {
    await command({action:"prepare"});
    app.engine.agents.router.registry.saveConfig("nord", {mode:"review",maxRunUsd:25,dailyUsd:100,concurrency:3});
    app.engine.agents.memory.append("nord",{title:"Product language",content:"Use the approved ceramic product details, simple forms and quiet palette. Avoid unsupported performance claims.",kind:"approved"});
    app.engine.agents.start();
    console.log(JSON.stringify({action,ok:true}));return;
  }
  if(action==="auth-view"){cookie="";console.log(JSON.stringify({action,ok:true}));return;}
  if(action==="facebook"){
    app.vault.set("metaAppId","1234567890");app.vault.set("metaAppSecret","test-only-app-secret-12345");app.vault.set("metaLoginConfigId","9876543210");app.vault.set("metaUserToken","test-user-credential");app.vault.set("glmKey","test-glm-credential");app.vault.set("minimaxKey","test-minimax-credential");app.vault.set("metaWebhookVerifyToken","test-only-verification-token");
    app.store.setSetting("metaOwner",{id:"123456789012345",appId:"1234567890",name:"Alex Morgan"});
    app.store.setSetting("metaConnection",{method:"oauth",status:"connected",appId:"1234567890",userId:"123456789012345",name:"Alex Morgan",permissions:Object.keys(META_PERMISSIONS),expiresAt:Date.now()+60*86400000,dataAccessExpiresAt:Date.now()+90*86400000,connectedAt:new Date().toISOString(),reason:""});
    app.store.setSetting("metaSelection",{accountIds:["act_123456"],pageIds:["456789"],updatedAt:new Date().toISOString()});await app.engine.meta.discover();console.log(JSON.stringify({action,ok:true}));return;
  }
  if(action==="reconnect"){invalidateMetaConnection(app.store,app.vault,"Facebook access has expired. Reconnect to restore access.");console.log(JSON.stringify({action,ok:true}));return;}
  if(action==="prepare"){
    await command({action:"setup"});await command({action:"brand",brand:{mode:"LIVE",instagramUserId:"777777"}});
    const preparedBrand=app.engine.brand("nord");await api("/api/brands/nord/autonomy","POST",{enabled:true,dailyBudgetMinor:preparedBrand.spend.dailyBudgetMinor,maxDailyBudgetMinor:preparedBrand.spend.maxDailyBudgetMinor});
    const run=await api("/api/brands/nord/run","POST",{});await finish(app.engine,String(run.id));
    for (const c of app.store.list<Creative>("creatives")) await app.engine.production.voice(app.engine.brand(c.brandId),c,join(app.store.dir,`narration-${c.id}.mp3`),false);
    await command({action:"performance",kind:"mixed"});await command({action:"facebook"});
    app.engine.engagement.save("nord",{mode:"auto",dailyLimit:50,rules:[{label:"Care",questions:["How do I clean it?"],reply:"Clean it gently by hand with a soft cloth."}],aiEnabled:true,provider:"glm",model:"glm-5.2",aiDailyLimit:100,knowledgeUrls:[]});
    await app.engine.engagement.discover("nord");
    engagementServices.comment("456789_900001","What is it made of?");engagementServices.comment("456789_900002","How do I clean it?");engagementServices.comment("456789_900003","Is this available in matte white?");engagementServices.comment("456789_900004","Mine arrived damaged. Can you help?");engagementServices.comment("456789_900005","Can I book a consultation for a larger order?","456789_800002");engagementServices.comment("179001","What is it made of?","178001");
    for(const t of app.store.list<CommentThread>("commentThreads"))await app.engine.engagement.sync(t.id);
    for(const p of app.store.list<PageKnowledge>("pageKnowledge"))await app.engine.engagement.intelligence.refresh(p.id);
    const comments=app.store.list<AdComment>("comments");
    for(const remote of ["456789_900001","179001"])await app.engine.engagement.draft(comments.find(c=>c.remoteId===remote)!.id);
    for(const remote of ["456789_900001","456789_900002"])await app.engine.engagement.send(comments.find(c=>c.remoteId===remote)!.id);
    console.log(JSON.stringify({action,ok:true,pages:app.store.count("pageKnowledge"),comments:app.store.count("comments")}));return;
  }
  if(action==="setup"){
    await api("/api/setup","POST",{token:setupToken(app.store),password});
    for(const name of ["metaToken","metaAppId","metaAppSecret","openaiKey","seedanceKey","minimaxKey"] as const)app.vault.set(name,"test-only-not-a-real-credential");
    console.log(JSON.stringify({action,ok:true}));return;
  }
  if(action==="login"){await api("/api/login","POST",{password});console.log(JSON.stringify({action,ok:true}));return;}
  if(action==="brand"){
    const b=fixture({autonomy:false,mode:"STAGE",...(input["brand"] as Record<string,unknown>??{})});
    await api("/api/brands","POST",b);console.log(JSON.stringify({action,id:b.id}));return;
  }
  const brand=app.store.list<ManagedBrand>("brands")[0];
  if(action==="state"){
    console.log(JSON.stringify({brands:app.store.list<ManagedBrand>("brands").map(b=>({id:b.id,mode:b.mode,autonomy:b.autonomy})),runs:app.store.list<CampaignRun>("runs").map(r=>({id:r.id,phase:r.phase,status:r.status,stages:r.stages})),jobs:app.store.db.prepare("SELECT kind,state,error FROM jobs").all()}));return;
  }
  if(action==="advance"){
    const run=app.store.list<CampaignRun>("runs").find(r=>!['complete','cancelled'].includes(r.status));
    if(!run)throw new Error("No pending run");current=run.id;await app.engine.advance(run.id);
    const after=app.store.get<CampaignRun>("runs",run.id)!;console.log(JSON.stringify({action,phase:after.phase,status:after.status,creativeCount:after.creativeIds.length}));return;
  }
  if(action==="complete"){
    const run=app.store.list<CampaignRun>("runs").find(r=>!['complete','cancelled'].includes(r.status));if(!run)throw new Error("No pending run");
    current=run.id;await finish(app.engine,run.id);console.log(JSON.stringify({action,ok:true}));return;
  }
  if(action==="performance"){
    if(!brand)throw new Error("No brand");
    const run=app.store.list<CampaignRun>("runs",brand.id).find(r=>r.mode==="LIVE"&&!r.repair&&r.status==="complete")!;if(!run)throw new Error("No completed live run");
    current=run.id;
    const shift=(new Date().getUTCHours()-8+12)%24-12;brand.timezone=`Etc/GMT${shift>=0?"+":""}${shift}`;
    brand.autonomy=true;brand.lifetimeLimitMinor=0;
    for(const stage of run.stages){stage.active=true;stage.activationPending=false;services.nodes.get(stage.campaignId)!["status"]="ACTIVE";services.nodes.get(stage.adSetId)!["status"]="ACTIVE";
      for(const ad of stage.adIds)services.nodes.get(ad)!["effective_status"]="ACTIVE";}
    if(input["kind"]==="roas")brand.spend.targetRoas=3;else delete brand.spend.targetRoas;
    services.setPerformance(run,brand,String(input["kind"]) as Parameters<MockServices["setPerformance"]>[2]);
    app.store.put("brands",brand);app.store.put("runs",run);
    // Each screenshot scenario is an independent experiment with a fresh decision history.
    app.store.db.prepare("DELETE FROM documents WHERE collection='decisions' AND brand_id=?").run(brand.id);
    await app.engine.monitor(brand.id);console.log(JSON.stringify({action,kind:input["kind"],decisions:app.store.list("decisions",brand.id)}));return;
  }
  if(action==="limit"){
    if(!brand)throw new Error("No brand");brand.lifetimeLimitMinor=1;brand.autonomy=true;app.store.put("brands",brand);await app.engine.monitor(brand.id);console.log(JSON.stringify({action,paused:!app.engine.brand(brand.id).autonomy}));return;
  }
  if(action==="failure"){
    let used=false;
    services.failure=req=>{if(!used&&req.path==="/v1/responses"){used=true;return Response.json({error:{message:"Injected temporary service limit"}},{status:429});}return undefined;};
    const run=app.store.list<CampaignRun>("runs").find(r=>r.status!=="complete"&&r.status!=="cancelled")!;
    if(!run)throw new Error("No pending run");while(app.store.get<CampaignRun>("runs",run.id)!.phase!=="copy")await app.engine.advance(run.id);
    app.store.enqueue("run",run.id);await app.engine.tick();await app.engine.tick();console.log(JSON.stringify({action,run:app.store.get("runs",run.id)}));return;
  }
  if(action==="cleanup"){
    app.engine.stop();services.failure=undefined;await app.engine.pauseAll();
    app.store.db.exec("DELETE FROM documents; DELETE FROM jobs; DELETE FROM effects; DELETE FROM charges; DELETE FROM secrets; DELETE FROM locks;");
    app.store.db.prepare("DELETE FROM settings WHERE key NOT IN ('ownerPassword')").run();
    rmSync(join(dir,"media"),{recursive:true,force:true});current="";services.nodes.clear();services.rows=[];
    console.log(JSON.stringify({action,brands:app.store.count("brands"),runs:app.store.count("runs"),leads:app.store.count("leads"),metrics:app.store.count("metrics"),secrets:Number(app.store.db.prepare("SELECT COUNT(*) AS n FROM secrets").get()!["n"])}));return;
  }
  throw new Error("Unknown fixture command");
}
const line=createInterface({input:process.stdin});let sequence=Promise.resolve();
line.on("line",text=>{sequence=sequence.then(()=>command(JSON.parse(text))).catch(error=>console.error(String(error)));});
let lastCommand="";
const commands=setInterval(()=>{
  const path=resolve("test/.browser-command.json");if(!existsSync(path))return;
  const text=readFileSync(path,"utf8");if(text===lastCommand)return;lastCommand=text;
  sequence=sequence.then(async()=>{
    const input=JSON.parse(text);await command(input);
    writeFileSync("test/.browser-result.json",JSON.stringify({request:input,ok:true}));
  }).catch(error=>writeFileSync("test/.browser-result.json",JSON.stringify({ok:false,error:String(error)})));
},250);commands.unref();
async function close(){await sequence;await new Promise<void>(resolve=>proxy.close(()=>resolve()));await app.close();rmSync(dir,{recursive:true,force:true});process.exit(0);}
process.on("SIGTERM",()=>void close());process.on("SIGINT",()=>void close());
