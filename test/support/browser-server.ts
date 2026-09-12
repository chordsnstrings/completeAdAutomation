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
import type { CampaignRun, ManagedBrand, Settings } from "../../src/app/types.ts";
import { DEFAULT_SETTINGS } from "../../src/app/types.ts";
import { MockServices, MockMeta, MockProduction, fixture, finish } from "./mock-workspace.ts";

// Explicitly disposable browser fixture. No production database, credentials, worker,
// or provider transport is used. Authentication itself is tested over the real API;
// the local proxy supplies that test session to exercise authenticated UI workflows.
if (process.env["SC_ENABLE_QA"] !== "1") throw new Error("This test fixture requires SC_ENABLE_QA=1.");
const dir=mkdtempSync(join(tmpdir(),"spend-browser-test-"));
const services=new MockServices();services.mediaDir=resolve(process.argv[2]??"../workflow-evidence/media");
const origin="http://terminal.local:4173";
const app=createApp({dataDir:dir,uiDir:resolve("ui"),origin,startWorker:false,
  engineFactory:(s,v)=>new Engine(s,v,{meta:new MockMeta(s,v,services),production:new MockProduction(s,v,services)})});
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
    if(cookie)headers.set("cookie",cookie);
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
  if(action==="setup"){
    await api("/api/setup","POST",{token:setupToken(app.store),password});
    for(const name of ["metaToken","metaAppId","metaAppSecret","openaiKey","seedanceKey"] as const)app.vault.set(name,"test-only-not-a-real-credential");
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
