import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../src/app/store.ts";
import { Vault } from "../../src/app/security.ts";
import { Engine } from "../../src/app/engine.ts";
import { Production } from "../../src/app/production.ts";
import { MetaGateway } from "../../src/app/meta.ts";
import { validateManagedBrand } from "../../src/app/validation.ts";
import { DEFAULT_SETTINGS, nowIso } from "../../src/app/types.ts";
import type { ManagedBrand, CampaignRun, Creative, Check, Metric } from "../../src/app/types.ts";
import { currencyOffset } from "../../src/meta/publish.ts";
import { MetaScheduler } from "../../src/meta/scheduler.ts";
import type { publicBytes } from "../../src/app/network.ts";

// Test-only adapters. Production startup never imports this module. Unknown requests
// fail immediately: these fixtures cannot fall through to paid or live services.
export const approved = "Considered ceramic objects for everyday living. Explore simple forms and a quiet palette, made for the spaces and routines that matter to you. Discover the NORD collection and find your everyday favourite.";
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=", "base64");
export function fixture(overrides: Record<string, unknown> = {}): ManagedBrand {
  return validateManagedBrand({
    id: "nord", name: "NORD Objects", archetype: "website_purchase",
    destination: { url: "https://example.com/collection", pixelId: "123456789", customEventType: "PURCHASE" },
    spend: { dailyBudgetMinor: 100000, maxDailyBudgetMinor: 300000, targetCpaMinor: 1000 },
    claims: { substantiated: [approved] }, countries: ["US"], currency: "USD", timezone: "UTC",
    proposition: "Ceramic objects with simple forms and a quiet palette.", mode: "LIVE", autonomy: true,
    funnel: "single_engine", creativesPerCycle: 2, adAccountId: "act_123456", pageId: "456789",
    generationDailyUsd: 250, ...overrides,
  });
}
export interface CapturedRequest { method: string; path: string; params: Record<string, string>; body: unknown }
type RemoteNode = Record<string, unknown> & { id: string };
export class MockServices {
  nodes = new Map<string, RemoteNode>();
  requests: CapturedRequest[] = [];
  rows: Record<string, unknown>[] = [];
  checks: Check[] = [];
  counter = 9000000000;
  videoPending = false;
  visualFailures = 0;
  blockAccount = false;
  mediaDir = "";
  failure: ((r: CapturedRequest) => Response | Error | undefined) | undefined;
  asset: typeof publicBytes = async (uri) => {
    if (uri.includes("product")) return { bytes: png, contentType: "image/png" };
    if (uri.startsWith("https://media.example.com/"))
      return { bytes: this.mediaDir ? readFileSync(join(this.mediaDir, "shot.mp4")) : Buffer.from("mock video bytes"), contentType: "video/mp4" };
    throw new Error(`Unexpected mock asset request: ${uri}`);
  };
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const bodyText = String(init?.body ?? "");
    const params = Object.fromEntries(method === "GET" ? url.searchParams : new URLSearchParams(bodyText));
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    const body: unknown = bodyText.startsWith("{") ? JSON.parse(bodyText) : params;
    const r = {method, path, params, body};
    this.requests.push(r);
    const failure = this.failure?.(r);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    if (url.hostname === "api.openai.com") {
      if (path.startsWith("/v1/models")) return Response.json({data:[{id:"gpt-4.1-mini"}]});
      if (path === "/v1/audio/speech") return new Response(this.mediaDir ? new Uint8Array(readFileSync(join(this.mediaDir,"voice.mp3"))) : new Uint8Array(128).fill(1), {headers:{"content-type":"audio/mpeg"}});
      if (path === "/v1/responses") {
        const payload = body as {instructions:string;input:Array<{content:Array<{text?:string}>}>};
        const context = JSON.parse(payload.input[0]!.content[0]!.text!);
        const format = (body as {text?:{format?:{schema?:{properties?:Record<string,unknown>}}}}).text?.format?.schema;
        const properties = format?.properties ?? {};
        const visual = payload.instructions.startsWith("Review this contact sheet");
        const agent = properties["summary"] ? {summary:"Use truthful product details and compare mature business outcomes.", ...(properties["approved"] ? {approved:true,findings:[]} : properties["action"] ? {action:"allow-scale"} : {recommendations:["Test a distinct, substantiated creative hook."]}),sourceIds:[],confidence:0.9} : properties["verified"] ? {verified:true} : null;
        const value = agent ?? (visual
          ? (this.visualFailures-- > 0 ? {verdict:"BLOCK", findings:["Mock unreadable headline"]} : {verdict:"PASS",findings:["Mock reviewer approved the fixture."]})
          : {creatives:Array.from({length:Number(context.count)},(_,i)=>({
              angle:i ? "A quieter everyday" : "Objects with intention", headline:i ? "A quieter everyday" : "Objects with intention",
              copy: approved.slice(0,240), voiceover:approved, onScreenText:"Considered objects for everyday living",
              template:i%2 ? "listicle" : "problem_solution_demo",
              shots:["A ceramic vessel on a warm stone surface. Slow camera movement.","A close view of the ceramic form in soft daylight. Slow camera movement."],
            }))});
        return Response.json({status:"completed",output:[{content:[{type:"output_text",text:JSON.stringify(value)}]}],usage:{input_tokens:900,output_tokens:250,input_tokens_details:{cached_tokens:200}}});
      }
    }
    if (url.hostname === "api.minimax.io" && path.startsWith("/v2/")) {
      if (method === "POST" && path === "/v2/video_generation") return Response.json({task_id:`mock-h3-${++this.counter}`},{headers:{"x-request-id":`h3-request-${this.counter}`}});
      if (method === "GET" && path.startsWith("/v2/query/video_generation/")) return Response.json({task:{id:path.split("/").at(-1),model:"MiniMax-H3",status:this.videoPending?"running":"succeeded",content:{url:"https://media.example.com/shot.mp4"},resolution:"768P",duration:8,ratio:"9:16",usage:{input_seconds:0,output_seconds:8,input_image_count:0,prompt_tokens:1200,completion_tokens:200000,total_tokens:201200}}});
    }
    if (url.hostname === "ark.ap-southeast.bytepluses.com") {
      if (path.endsWith("/models")) return Response.json({data:[]});
      if (method === "POST" && path.endsWith("/contents/generations/tasks")) return Response.json({id:`mock-task-${++this.counter}`});
      if (method === "GET" && path.includes("/contents/generations/tasks/")) return Response.json({id:path.split("/").at(-1),status:this.videoPending?"running":"succeeded",content:{video_url:"https://media.example.com/shot.mp4"},usage:{completion_tokens:1000}});
    }
    if (url.hostname !== "graph.facebook.com") throw new Error(`Unexpected external request blocked by mock services: ${url.origin}${path}`);
    if (path === "me/adaccounts") return Response.json({data:[{id:"act_123456",name:"NORD · Test account",currency:"USD",timezone_name:"UTC",account_status:1}]});
    if (path === "me/assigned_pages") return Response.json({data:[{id:"456789",name:"NORD Objects"}]});
    if (path.endsWith("/insights")) return Response.json({data:this.rows});
    if (method === "POST") {
      if (/\/(campaigns|adsets|ads|adcreatives|customaudiences|leadgen_forms)$/.test(path)) {
        const id=String(++this.counter), node:RemoteNode={id,...params};
        for (const key of ["targeting","attribution_spec","creative"]) if (params[key]) node[key]=JSON.parse(params[key]);
        node["effective_status"]=params["status"]??"PAUSED";
        node["created_time"]=nowIso();
        this.nodes.set(id,node);
        return Response.json({id});
      }
      if (path.endsWith("/events")) return Response.json({events_received:1,fbtrace_id:"mock-trace"});
      const node=this.nodes.get(path);
      if (node) {
        Object.assign(node,params);
        if (params["targeting"]) node["targeting"]=JSON.parse(params["targeting"]);
        if (params["status"]) node["effective_status"]=params["status"];
        return Response.json({success:true});
      }
    }
    if (method === "GET") {
      if (path.endsWith("/leads")) return Response.json({data:[]});
      if (/\/(campaigns|adsets|ads|adcreatives|customaudiences)$/.test(path)) {
        const fields=(params["fields"]??"").split(",");
        return Response.json({data:[...this.nodes.values()].filter(n=>fields.every(f=>f in n))});
      }
      const node=this.nodes.get(path);
      if (node) return Response.json({
        approximate_count_lower_bound:5000, delivery_status:{code:200,description:"Ready"},operation_status:{code:200,description:"Ready"},
        learning_stage_info:{status:"SUCCESS",last_sig_edit_ts:Math.floor(Date.now()/1000)-40*86400},
        attribution_spec:[{event_type:"CLICK_THROUGH",window_days:7}],...node,
      });
      if (/^\d+$/.test(path)) return Response.json({id:path,approximate_count_lower_bound:5000,delivery_status:{code:200,description:"Ready"},operation_status:{code:200,description:"Ready"}});
    }
    throw new Error(`Unexpected Meta fixture request: ${method} ${path}`);
  };
  setPerformance(run: CampaignRun, brand: ManagedBrand, kind: "learning" | "winner" | "loser" | "mixed" | "roas" | "zero" | "equivalent" = "winner") {
    this.rows=[];
    run.createdAt=new Date(Date.now()-40*86400000).toISOString();
    const offset=currencyOffset(brand.currency);
    for (const stage of run.stages) {
      const set=this.nodes.get(stage.adSetId)!;
      set["learning_stage_info"]={status:kind==="learning"?"LEARNING":"SUCCESS",last_sig_edit_ts:Math.floor(Date.now()/1000)-40*86400};
      for (const [index,adId] of stage.adIds.entries()) {
        const ad=this.nodes.get(adId)!; ad["created_time"]=run.createdAt;
        for (let ago=27;ago>=0;ago--) {
          const spendMinor=kind==="zero"?0:10000;
          const conversions=kind==="loser"?0:kind==="mixed"?(index===0?40:1):kind==="zero"?0:(kind==="winner"||kind==="roas")?(index===0?40:10):40;
          this.rows.push({ad_id:adId,adset_id:stage.adSetId,date_start:new Date(Date.now()-ago*86400000).toISOString().slice(0,10),
            spend:String(spendMinor/offset),impressions:"5000",clicks:"150",reach:"4500",attribution_setting:"7d_click",
            actions:[{action_type:stage.primaryAction,value:String(conversions)}],
            action_values:[{action_type:stage.primaryAction,value:String(kind==="roas"?1:conversions*40)}]});
        }
      }
    }
  }
}
export class MockMeta extends MetaGateway {
  private clock = Date.now();
  override readonly scheduler = new MetaScheduler({ now: () => (this.clock += 60000) });
  readonly services: MockServices;
  constructor(store: Store,vault: Vault,services: MockServices) { super(store,vault,services.fetch); this.services=services; }
  override async check(b:ManagedBrand):Promise<Check[]> {
    b.account={adAccountId:b.adAccountId,currency:b.currency};
    b.lastCheckedAt=nowIso();
    b.preflight=this.services.blockAccount?[{name:"Mock account",severity:"BLOCK",detail:"Injected account restriction"}]:[{name:"Mock account",severity:"PASS",detail:"Isolated test account. No real delivery."},...this.services.checks];
    this.store.put("brands",b);
    return b.preflight;
  }
}
export class MockProduction extends Production {
  readonly services: MockServices;
  constructor(store:Store,vault:Vault,services:MockServices) { super(store,vault,services.fetch,services.asset); this.services=services; }
  override async render(b:ManagedBrand,c:Creative,simulation=false) {
    const dir=join(this.store.dir,"media",c.id);mkdirSync(dir,{recursive:true});
    if (this.services.mediaDir) {
      for (const file of ["9x16.mp4","4x5.mp4","1x1.mp4","poster.jpg","contact.jpg"]) copyFileSync(join(this.services.mediaDir,file),join(dir,file));
    } else {
      for (const file of ["9x16.mp4","4x5.mp4","1x1.mp4"]) writeFileSync(join(dir,file),"mock-video");
      writeFileSync(join(dir,"poster.jpg"),png);writeFileSync(join(dir,"contact.jpg"),png);
    }
    c.file=join(dir,"9x16.mp4");c.poster=join(dir,"poster.jpg");c.variants={"9:16":c.file,"4:5":join(dir,"4x5.mp4"),"1:1":join(dir,"1x1.mp4")};
    c.qa=[{name:"Fixture media",severity:"PASS",detail:"Media assembly is exercised separately with real FFmpeg."}];
    c.status="rendered";c.videoId=String(++this.services.counter);c.imageHash="mock-poster-hash";
    c.metaAccountId=b.adAccountId;c.metaPageId=b.pageId;
    this.store.put("creatives",c);
  }
}
export function workspace() {
  const dir=mkdtempSync(join(tmpdir(),"spend-workflow-test-")),store=new Store(dir),vault=new Vault(store),services=new MockServices();
  store.setSetting("app", { ...DEFAULT_SETTINGS, provider:"seedance", videoModel:"seedance-1-5-pro-251215" });
  for (const name of ["metaToken","metaAppId","metaAppSecret","openaiKey","seedanceKey","minimaxKey"] as const) vault.set(name,"test-only-not-a-real-credential");
  const meta=new MockMeta(store,vault,services),production=new MockProduction(store,vault,services),engine=new Engine(store,vault,{meta,production});
  return {dir,store,vault,services,meta,production,engine,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
export async function finish(engine:Engine,id:string) {
  for (let i=0;i<20;i++) { await engine.advance(id); const run=engine.store.get<CampaignRun>("runs",id)!; if(run.status==="complete") return run; }
  throw new Error("Fixture did not complete");
}
export function storedMetrics(store:Store,brandId:string) { return store.list<Metric>("metrics",brandId).filter(m=>!m.simulation); }
