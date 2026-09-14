import { createStudio } from "/studio.js";
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app"),
  dialog = $("#dialog");
const state = {
  data: null,
  csrf: "",
  brand: "",
  currency: "",
  metric: "spendMinor",
  days: 14,
  runFilter: "all",
  creativeFilter: "all",
  funnelBrand: "",
  plans: null,
  loadingPlans: false,
  online: true,
  usage: null, usageLoading: false, usageKey: "", usageRequest: 0, usageError: "", usageOffset: 0,
  usageFilters: { from: new Date(Date.now()-27*86400000).toISOString().slice(0,10), to: new Date().toISOString().slice(0,10), provider: "", action: "", status: "", run: "", creative: "" },
  comments: null, commentsLoading: false, commentsKey: "", commentFilter: "attention", commentRequest: 0,
};
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const human = (v) =>
  String(v ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const paths = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  brands: '<path d="M4 8h16v13H4zM8 8V5a4 4 0 0 1 8 0v3"/>',
  campaigns: '<path d="m4 11 15-7v16l-15-7zM5 13l3 8h4l-3-7"/>',
  funnels: '<path d="M3 4h18l-7 9v6l-4 2v-8z"/>',
  creatives:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4z"/>',
  engagement: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5z"/><path d="M7 10h10M7 14h6"/>',
  intelligence: '<path d="M4 3h12l4 4v14H4zM14 3v6h6M8 13h8M8 17h5"/>',
  agents: '<path d="M12 3v4M5 8l3 3m11-3-3 3M4 17h4m12 0h-4"/><circle cx="12" cy="13" r="4"/>',
  roi: '<path d="M3 3v18h18M6 16l4-5 4 2 6-8"/>',
  usage: '<rect x="3" y="2" width="18" height="20" rx="2"/><path d="M7 7h10M7 12h4M7 17h4M15 12h2M15 17h2"/>',
  learning: '<path d="M4 19V9m6 10V4m6 15v-7m5 7H2"/>',
  connections:
    '<path d="m8 3 3 3-5 5-3-3m10 10 5-5 3 3-5 5M8 8l8 8M3 21l4-4M17 7l4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  down: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 14 8-14 8z"/>',
  refresh:
    '<path d="M20 8A9 9 0 0 0 5 5L2 8m0-5v5h5m-3 8a9 9 0 0 0 15 3l3-3m0 5v-5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 11 3 3 5-5"/>',
  money:
    '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M5 12h1m12 0h1"/>',
  target:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  spark:
    '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M9 4H4v16h5m6-13 5 5-5 5m-6-5h11"/>',
  edit: '<path d="m15 3 6 6-12 12H3v-6zM12 6l6 6"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-5-5 3-3m-6 0 3-3"/>',
  external: '<path d="M14 3h7v7m0-7L11 13M10 3H3v18h18v-7"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
};
const icon = (name, size = 17) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.info}</svg>`;
const btn = (label, action, id = "", style = "", glyph = "") =>
  `<button type="button" class="btn ${style}" data-action="${action}" data-id="${esc(id)}">${glyph ? icon(glyph, 15) : ""}${esc(label)}</button>`;
const badge = (label, color = "") =>
  `<span class="badge ${color}">${esc(label)}</span>`;
const modeBadge = (mode) =>
  badge(
    mode === "SIMULATE"
      ? "Simulation"
      : mode === "STAGE"
        ? "Paused staging"
        : mode === "VALIDATE"
          ? "Validation"
          : "Live",
    mode === "LIVE" ? "green" : mode === "SIMULATE" ? "blue" : "amber",
  );
const statusBadge = (s) =>
  badge(
    human(s),
    ["complete", "passed", "published", "PASS", "delivered"].includes(s)
      ? "green"
      : ["blocked", "BLOCK", "failed"].includes(s)
        ? "red"
        : ["waiting", "WARN", "cancelled"].includes(s)
          ? "amber"
          : "blue",
  );
const goalNames = {
  website_purchase: "Website purchases",
  website_lead: "Website enquiries",
  instant_form_lead: "Instant lead forms",
  messenger_lead: "Messenger enquiries",
  whatsapp_conversation: "WhatsApp conversations",
  phone_call: "Phone calls",
  catalog_sales: "Catalogue sales",
  traffic: "Website visits",
  app_install: "App installs",
};
const funnelDescriptions = {
  single_engine:
    "One focused conversion campaign. Give the algorithm room to learn with a concentrated budget.",
  seed_and_harvest:
    "Build an initial video audience while a conversion campaign finds customers. The seed stage ends after 45 days.",
  broad_plus_recapture:
    "Broad acquisition, with a smaller campaign to address objections from people who already know you.",
  full_three_stage:
    "Distinct awareness, consideration, and conversion campaigns for a substantial budget and an established audience.",
  value_ladder:
    "Find high-value customers, then support repeat purchases with a small, dedicated retention campaign.",
};
const stageDescriptions = {
  engine: "Concentrate your budget in one campaign so each creative has enough delivery to learn.",
  seed: "Build initial video engagement. The seed stops once enough purchases arrive, when the audience is too small after 30 days, or at the 45-day limit.",
  harvest: "Find customers with a conversion campaign. Once eligible, a conversion lookalike becomes an audience suggestion in the existing ad set.",
  prospecting: "Introduce the brand to new customers with a clear opening message.",
  recapture: "Address questions and objections from people who have already engaged with the brand.",
  tof: "Introduce the brand to a broader audience with a dedicated reach campaign.",
  mof: "Develop interest with deeper product stories and warm audience suggestions.",
  bof: "Help interested website visitors and cart starters complete their purchase.",
  value_prospecting: "Find more customers like your highest-value buyers using a value-based lookalike.",
  existing_customer: "Encourage repeat purchases with a modest budget for existing customers.",
};
const nav = [
  ["overview", "Overview"],
  ["brands", "Brands"],
  ["campaigns", "Campaigns"],
  ["funnels", "Funnel studio"],
  ["creatives", "Creative library"],
  ["engagement", "Engagement"],
  ["intelligence", "Page intelligence"],
  ["agents", "Agent studio"],
  ["roi", "Experiments & ROI"],
  ["learning", "Decisions & activity"],
  ["usage", "Usage & costs"],
  ["connections", "Connections"],
];
const currentPage = () =>
  nav.some((n) => n[0] === location.hash.slice(1))
    ? location.hash.slice(1)
    : "overview";
const usageLabels = { 'agent-analysis':'Agent analysis', 'model-probe':'Connection test', 'message-draft':'Message draft', 'creative-copy':'Creative copy', 'visual-review':'Visual review', 'video-generation':'Video generation', narration:'Narration', 'page-profile':'Page profile', 'comment-draft':'Comment draft', 'reply-verification':'Reply verification', legacy:'Historical record' };
const costLabels = { calculated:'Calculated', estimated:'Estimated', reserved:'Reserved', unknown:'Unresolved', 'not-charged':'Not charged' };
const preciseUsd = (micros) => micros === null || micros === undefined ? 'Unknown' : '$' + (micros / 1e6).toLocaleString('en-US',{minimumFractionDigits:4,maximumFractionDigits:6});
const usageNumber = (v) => v === null || v === undefined ? '—' : v.toLocaleString('en-US',{maximumFractionDigits:6});
function usageParams() { return new URLSearchParams({ ...state.usageFilters, brand:state.brand, offset:String(state.usageOffset), limit:'50' }); }
async function loadUsage() {
  if(state.usageLoading)return;
  const key=usageParams().toString(), request=++state.usageRequest;state.usageLoading=true;
  try {
    const result=await api('/usage?'+key);
    if(request!==state.usageRequest || key!==usageParams().toString())return;
    state.usage=result;state.usageError='';state.usageKey=key;
  } catch(error) { if(key===usageParams().toString()){state.usageError=error.message;state.usage=null;state.usageKey=key;} }
  finally {state.usageLoading=false;if(currentPage()==='usage')render();}
}
function usageBreakdown(title, rows, label=(s)=>s) {
  return `<section class="panel"><div class="panel-head"><h2>${esc(title)}</h2></div><div class="table-wrap"><table class="usage-breakdown"><thead><tr><th>Source</th><th>Requests</th><th>Calculated</th><th>Est. / reserved</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(label(r.label))}</td><td>${usageNumber(r.requests)}</td><td>${preciseUsd(r.calculatedMicros)}</td><td>${preciseUsd(r.estimatedMicros)}${r.unpricedRequests ? '<span class="sub">'+r.unpricedRequests+' unpriced</span>':''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No requests in this view.</td></tr>'}</tbody></table></div></section>`;
}
function usage() {
  const key=usageParams().toString();
  if(state.usageKey!==key&&!state.usageLoading)void loadUsage();
  const d=state.usageKey===key ? state.usage : null,t=d?.totals,f=state.usageFilters;
  const select=(name,label,options)=>`<label>${esc(label)}<select data-usage-filter="${name}">${options.map(([v,l])=>`<option value="${esc(v)}" ${f[name]===v?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
  return heading('Every request, accounted for.','Video seconds, AI tokens, and the cost of each step across your brands.',btn('Model rates','usage-pricing','','','edit')+`<a class="btn" href="/api/usage/export?${esc(usageParams().toString())}">${icon('down',15)}Export CSV</a>`,'Usage & costs')+
    `<div class="usage-contract"><div class="service">${icon('creatives',23)}</div><div><strong>MiniMax H3 <span class="badge blue">768P</span></strong><p>Published rate: $0.08 / output second · 8s shot $0.64 · 16s creative $1.28</p></div><a href="#connections" class="small">Provider settings ${icon('arrow',13)}</a></div>`+
    `<section class="panel usage-filters" aria-label="Usage filters"><label>From (UTC)<input type="date" data-usage-filter="from" value="${esc(f.from)}"></label><label>Through (UTC)<input type="date" data-usage-filter="to" value="${esc(f.to)}"></label>${select('provider','Provider',[['','All providers'],['minimax','MiniMax'],['openai','OpenAI'],['glm','Z.AI'],['seedance','Seedance'],['veo','Google Veo'],['unknown','Historical / unknown']])}${select('action','Activity',[['','All activities'],...Object.entries(usageLabels)])}${select('status','Cost status',[['','All statuses'],...Object.entries(costLabels)])}</section>`+
    (f.run||f.creative ? `<div class="notice">${icon('info')}<span>Showing ${f.run?'campaign run':'creative'} ${esc(f.run||f.creative)}.</span>${btn('Clear','usage-clear','','tiny')}</div>`:'')+
    (state.usageError ? `<div class="notice error">${esc(state.usageError)} ${btn('Try again','usage-reload','','tiny')}</div>`:'')+
    `<section class="stats" aria-label="AI cost summary">${stat('Calculated cost',t?preciseUsd(t.calculatedMicros):'—','Provider usage × saved rates · USD','money')}${stat('Estimates & reservations',t?preciseUsd(t.estimatedMicros):'—',t?`${t.pendingRequests} reserved · ${t.unknownRequests} unresolved`:'Awaiting usage data','clock')}${stat('Reported tokens',t?.totalTokensReports?usageNumber(t.totalTokens):'—',t?`${t.cachedTokensReports?usageNumber(t.cachedTokens)+" reported cached":"Cache not reported"} · ${t.reasoningTokensReports?usageNumber(t.reasoningTokens)+" reported reasoning":"reasoning not reported"}`:'Input, output and provider details','spark')}${stat('Generated video seconds',t?.outputVideoSecondsReports?usageNumber(t.outputVideoSeconds):'—',t?`${t.requests} requests · ${usageNumber(t.characters)} narration characters`:'Based on reported task usage','creatives')}</section>`+
    `<p class="usage-explainer">Calculated costs use saved rates and provider receipts. Estimates are separate and may change. H3 is billed by seconds and extra images; its token counts are informational. Cached and reasoning tokens are subsets, not additional tokens. Narration uses a character estimate. Advertising spend is in Overview.</p>`+
    (t?.unpricedRequests ? `<div class="notice warn">${icon('info')}<span>${t.unpricedRequests} requests have no usable price or estimate. Totals are incomplete; review their details.</span></div>`:'')+
    `<div class="usage-breakdowns">${usageBreakdown('By model',d?.byModel||[])}${usageBreakdown('By activity',d?.byAction||[],s=>usageLabels[s]||s)}</div>`+
    `<section class="panel mt"><div class="panel-head"><div><h2>Request ledger</h2><p>${state.usageLoading?'Loading requests…':`${t?.requests||0} requests match these filters`} · costs shown to a millionth of a dollar</p></div>${btn('Refresh','usage-reload','','tiny','refresh')}</div><div class="table-wrap"><table class="usage-table"><thead><tr><th>Time / brand</th><th>Activity / model</th><th>Input / output tokens</th><th>Video / narration</th><th>USD cost</th><th></th></tr></thead><tbody>${(d?.entries||[]).map(e=>`<tr><td><time datetime="${esc(e.createdAt)}">${esc(e.createdAt.slice(0,19).replace('T',' '))}</time><span class="sub">${esc(brandBy(e.brandId)?.name||e.brandId||'Workspace')} · UTC</span></td><td><strong>${esc(usageLabels[e.action]||e.action)}</strong><span class="sub">${esc(e.model)}${e.shotIndex!==undefined?' · Shot '+(e.shotIndex+1):''}</span><span class="small muted">${esc(human(e.state))} · attempt ${e.attempt}</span></td><td class="usage-numeric">${usageNumber(e.metrics.inputTokens)} / ${usageNumber(e.metrics.outputTokens)}<span class="sub">Cache ${usageNumber(e.metrics.cachedTokens)} · reasoning ${usageNumber(e.metrics.reasoningTokens)}</span><span class="sub">Total ${usageNumber(e.metrics.totalTokens)}</span></td><td>${e.rate.unit==='seconds' ? `${usageNumber(e.metrics.outputVideoSeconds)}s output<span class="sub">${usageNumber(e.metrics.inputVideoSeconds)}s input · ${usageNumber(e.metrics.inputImages)} images</span>` : e.rate.unit==='characters' ? `${usageNumber(e.metrics.characters)} chars` : e.rate.unit==='pixel-frame-tokens' ? `${usageNumber(e.metrics.pixelFrameTokens)} pixel-frame tokens` : '—'}</td><td class="usage-numeric"><strong>${preciseUsd(e.costStatus==='calculated'||e.costStatus==='not-charged'?e.costMicros:e.estimatedMicros)}</strong><span class="sub">${badge(costLabels[e.costStatus],e.costStatus==='calculated'?'green':e.costStatus==='unknown'?'amber':'')}</span></td><td>${btn('Details','usage-detail',e.id,'tiny','arrow')}</td></tr>`).join('') || `<tr><td colspan="6">${empty(state.usageLoading?'Loading usage…':'No paid requests in this view.','Try another date range or brand. Simulation does not incur provider charges.','','money')}</td></tr>`}</tbody></table></div><div class="panel-foot"><span>${d?.entries.length ? `${d.offset+1}–${d.offset+d.entries.length} of ${t.requests}`:'0 requests'} · — means not reported or not applicable</span><div class="heading-actions">${d?.offset?btn('Previous','usage-previous','','tiny'):''}${d?.hasMore?btn('Next','usage-next','','tiny'):''}</div></div></section>`+
    `<details class="usage-secondary mt"><summary>Agent roles, daily totals & brand allocation</summary><div class="usage-breakdowns mt">${usageBreakdown('By agent role',d?.byAgent||[],s=>human(s))}${usageBreakdown('By day · UTC',(d?.byDay||[]).toSorted((a,b)=>b.label.localeCompare(a.label)))}${usageBreakdown('By brand',d?.byBrand||[],s=>brandBy(s)?.name||s)}</div></details>`+
    `<p class="small muted mt">Production allowances apply in each brand’s timezone and include outstanding reservations. Engagement has its own daily request allowance. Provider invoices may differ because of credits, discounts, or taxes. Historical records retain only the information originally captured.</p>`;
}
function usageDetail(id) {
  const e=state.usage?.entries.find(e=>e.id===id);if(!e)return;
  const metricLabels={inputTokens:'Input tokens (includes cache)',outputTokens:'Output tokens (includes reasoning)',totalTokens:'Total tokens',cachedTokens:'Cached input tokens',reasoningTokens:'Reasoning output tokens',inputAudioTokens:'Input audio tokens',outputAudioTokens:'Output audio tokens',inputVideoSeconds:'Input video seconds',outputVideoSeconds:'Output video seconds',inputImages:'Input images',inputAudioSeconds:'Input audio seconds',characters:'Requested narration characters',pixelFrameTokens:'Pixel-frame tokens'};
  const relevant = e.rate.unit==='tokens'||e.metrics.totalTokens!==null ? ['inputTokens','outputTokens','totalTokens','cachedTokens','reasoningTokens'] : [];
  if(e.rate.unit==='seconds')relevant.push('inputVideoSeconds','outputVideoSeconds','inputImages');
  if(e.rate.unit==='characters')relevant.push('characters');
  if(e.rate.unit==='pixel-frame-tokens')relevant.push('pixelFrameTokens');
  const lines=Object.entries(e.metrics).filter(([k,v])=>v!==null||relevant.includes(k)).map(([k,v])=>`<tr><th scope="row">${esc(metricLabels[k])}</th><td>${usageNumber(v)}</td></tr>`).join('');
  const rate=e.rate;
  const rates=rate.unit==='tokens'?`Input $${rate.input ?? 'unknown'} / 1M · output $${rate.output ?? 'unknown'} / 1M · cache $${rate.cached ?? 'unknown'} / 1M${rate.longContext?`<br>Above ${usageNumber(rate.longContext.threshold)} input tokens: $${rate.longContext.input} / $${rate.longContext.output} / $${rate.longContext.cached} per 1M`:''}`:rate.unit==='seconds'?`$${rate.perSecond} per output or input-video second${rate.extraImage!==null?` · first ${rate.freeImages} images free, then $${rate.extraImage} each`:''}`:rate.unit==='characters'?`$${rate.perMillionCharacters} per million characters`:rate.unit==='pixel-frame-tokens'?`$${rate.output} per million pixel-frame tokens`:'Rate not captured';
  const context=[['Brand',brandBy(e.brandId)?.name||e.brandId],['Agent role',human(e.agentRole||'unattributed')],['Agent version',e.agentVersion],['Run',e.runId],['Creative',e.creativeId],['Stage',e.stageId],['Page profile',e.pageId],['Thread',e.threadId],['Comment',e.commentId],['Ads',e.adIds?.join(', ')],['Request ID',e.requestId],['Task ID',e.taskId],['HTTP status',e.httpStatus],['Elapsed',e.latencyMs===null?'':`${usageNumber(e.latencyMs)} ms`]].filter(([,v])=>v!==undefined&&v!==null&&v!=='');
  modal(usageLabels[e.action]||e.action,`${e.model} · ${e.createdAt.slice(0,19).replace('T',' ')} UTC`,
    `<div class="usage-receipt-head"><div><span class="eyebrow">${esc(costLabels[e.costStatus])} · USD</span><strong>${preciseUsd(e.costStatus==='calculated'||e.costStatus==='not-charged'?e.costMicros:e.estimatedMicros)}</strong></div>${statusBadge(e.state)}</div><p class="small muted">${esc(e.detail||'Request started; awaiting the provider receipt.')}</p><p class="small muted">Original estimate: ${preciseUsd(e.estimatedMicros)} · Attempt ${e.attempt}</p><section class="form-section"><h3>Usage breakdown</h3><div class="table-wrap"><table class="usage-receipt">${lines}</table></div><p class="small muted">— means not reported or not applicable. Cached tokens are included in input; reasoning tokens are included in output. Neither is added again to the total.</p></section><section class="form-section"><h3>Rate saved for this request</h3><p class="small">${rates}</p><p class="small muted">${esc(rate.note)}</p><p class="small muted">${esc(rate.source)}${rate.verifiedAt?' · '+esc(rate.verifiedAt):''}</p></section><details class="form-section"><summary>Attribution & provider receipt</summary><dl class="usage-context">${context.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}<dt>Ledger ID</dt><dd>${esc(e.id)}</dd></dl><details><summary class="small">Reported usage fields</summary><pre class="code">${esc(JSON.stringify(e.rawUsage,null,2))}</pre></details></details><div class="form-footer">${e.creativeId&&state.data.creatives.some(c=>c.id===e.creativeId)?btn('Open creative','creative-detail',e.creativeId,'tiny'):''}${btn('Close','close','','primary')}</div>`);
}
async function usagePricing() {
  const {rates}=await api('/usage/pricing');
  modal('Model rates','USD per million tokens. Changes apply to future requests.',`<p class="small muted">H3 video and OpenAI text rates are in Connections. Each paid request saves its own rate for an auditable history. These are standard pay-as-you-go estimates; use your contracted rates if different.</p>${rates.map(({key,model,rate:r})=>`<form data-form="usage-rate" data-key="${esc(key)}" class="form-section"><h3>${esc(model)}</h3><p class="small muted">${esc(r.source)} · ${esc(r.verifiedAt)}</p><div class="form-error" role="alert"></div><div class="form-grid">${field('input','Input / 1M',r.input,{type:'number',min:0,step:'0.000001',required:true})}${field('output','Output / 1M',r.output,{type:'number',min:0,step:'0.000001',required:true})}${field('cached','Cached input / 1M',r.cached,{type:'number',min:0,step:'0.000001',required:true})}${r.longContext?field('longInput','Above 512K: input / 1M',r.longContext.input,{type:'number',min:0,step:'0.000001',required:true})+field('longOutput','Above 512K: output / 1M',r.longContext.output,{type:'number',min:0,step:'0.000001',required:true})+field('longCached','Above 512K: cache / 1M',r.longContext.cached,{type:'number',min:0,step:'0.000001',required:true}):''}</div><div class="form-footer"><button class="btn primary">Save ${esc(model)} rates</button></div></form>`).join('')}`);
}
const brandBy = (id) => state.data.brands.find((b) => b.id === id);
const offset = (currency) => {
  const rules = state.data?.currencyRules;
  if (!rules) throw new Error("Currency rules are unavailable. Refresh the page before entering budgets.");
  if (!/^[A-Z]{3}$/.test(currency) || rules.unsupported.includes(currency))
    throw new Error("This currency is not supported for automated budgets.");
  return rules.wholeUnits.includes(currency) ? 1 : 100;
};
const money = (minor, currency = state.currency) =>
  currency
    ? new Intl.NumberFormat("en", {
        style: "currency",
        currency,
        maximumFractionDigits: minor % offset(currency) ? 2 : 0,
      }).format(minor / offset(currency))
    : "—";
const num = (v) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(v ?? 0);
const time = (s) => {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
  return m < 1
    ? "Just now"
    : m < 60
      ? `${m}m ago`
      : m < 1440
        ? `${Math.floor(m / 60)}h ago`
        : new Date(t).toLocaleDateString("en", {
            month: "short",
            day: "numeric",
          });
};
const symbol = (b) =>
  `<div class="brand-symbol">${esc(
    (b?.name ?? "?")
      .split(/\s+/)
      .map((x) => x[0])
      .slice(0, 2)
      .join("")
      .toUpperCase(),
  )}</div>`;
const selectedBrands = () =>
  state.data.brands.filter((b) => !state.brand || b.id === state.brand);
const reportingBrands = () =>
  selectedBrands().filter(
    (b) => !state.currency || b.currency === state.currency,
  );
const filterItems = (items) => {
  const ids = new Set(selectedBrands().map((b) => b.id));
  return items.filter((x) => ids.has(x.brandId));
};
const isSimulation = () =>
  reportingBrands().length > 0 &&
  reportingBrands().every((b) => b.mode === "SIMULATE");
const metrics = () => {
  const ids = new Set(
    reportingBrands()
      .filter((b) =>
        isSimulation() ? b.mode === "SIMULATE" : b.mode !== "SIMULATE",
      )
      .map((b) => b.id),
  );
  const min = new Date(Date.now() - (state.days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  return state.data.metrics.filter(
    (m) =>
      ids.has(m.brandId) && m.simulation === isSimulation() && m.date >= min,
  );
};
async function api(path, method = "GET", data) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": state.csrf } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !["/login", "/setup"].includes(path)) {
      state.data = null;
      dialog.close();
      await init();
    }
    throw new Error(value.error ?? "Something went wrong.");
  }
  return value;
}
function toast(message, error = false) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.innerHTML = `${icon(error ? "info" : "check")}<span>${esc(message)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), error ? 12000 : 5500);
}
function modal(title, subtitle, body, narrow = false) {
  dialog.className = narrow ? "dialog-narrow" : "";
  dialog.innerHTML = `<header class="dialog-head"><div><h2 id="dialog-title">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div><button type="button" class="icon-btn" data-action="close" aria-label="Close dialog">${icon("close")}</button></header><div class="dialog-body">${body}</div>`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
const heading = (title, description, actions = "", eyebrow = "") =>
  `<header class="page-heading"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="heading-actions">${actions}</div></header>`;
const empty = (title, description, actions = "", glyph = "spark") =>
  `<div class="empty"><div class="empty-icon">${icon(glyph, 24)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>`;
const checks = (items) =>
  `<div class="checks">${items.map((c) => `<div class="check">${statusBadge(c.severity)}<div><strong>${esc(c.name)}</strong><p>${esc(c.detail)}</p>${c.remedy ? `<p>${esc(c.remedy)}</p>` : ""}</div></div>`).join("")}</div>`;
const studio = createStudio({ state, api, esc, heading, badge, stat, modal, toast, render, refresh });
const agents = () => studio.render("agents"), roi = () => studio.render("roi");
function render() {
  if (!state.data) return;
  const page = currentPage(),
    d = state.data;
  const currencies = [...new Set(d.brands.map((b) => b.currency))];
  if (!currencies.includes(state.currency))
    state.currency = currencies[0] ?? "";
  if (state.brand && !brandBy(state.brand)) state.brand = "";
  const paused = d.settings.globalPaused;
  const expandedRuns = new Set([...app.querySelectorAll("[data-run-detail][open]")].map(el => el.dataset.runDetail));
  document.title = `${nav.find((n) => n[0] === page)[1]} · Spend Control`;
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="logo" href="#overview"><img src="/mark.svg" alt="">Spend Control</a><div class="workspace"><div class="workspace-icon">${icon("brands", 15)}</div><div><strong>Your workspace</strong><span>Meta advertising</span></div></div><div class="eyebrow nav-label">Workspace</div><nav class="nav" aria-label="Main navigation">${nav.map(([id, label]) => `<a href="#${id}" class="${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""}>${icon(id)}${label}${id === "campaigns" && d.runs.filter((r) => r.status === "blocked").length ? `<span class="count">${d.runs.filter((r) => r.status === "blocked").length}</span>` : ""}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="sync-status"><span class="dot ${paused || !state.online || !d.worker.enabled ? "paused" : ""}"></span>${!state.online ? "Connection interrupted" : paused ? "Workspace paused" : d.worker.enabled ? "Worker connected" : "Worker stopped"}</div><div class="account"><div class="avatar">SC</div><div><strong class="small">${esc(d.facebook?.owner || "Workspace owner")}</strong><p class="muted small">Administrator</p></div><button class="icon-btn" data-action="password" aria-label="Account settings">${icon("key", 16)}</button></div></div></aside><div class="main-wrap"><div class="topbar"><div class="breadcrumb"><button class="icon-btn mobile-menu" data-action="menu" aria-label="Toggle navigation" aria-expanded="false">${icon("menu")}</button><span>Workspace</span><span>/</span><strong>${nav.find((n) => n[0] === page)[1]}</strong></div><div class="top-actions"><select aria-label="Filter by brand" id="brand-filter"><option value="">All brands</option>${d.brands.map((b) => `<option value="${esc(b.id)}" ${state.brand === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select><span class="divider"></span><button class="icon-btn" data-action="refresh" aria-label="Refresh workspace">${icon("refresh", 16)}</button>${btn(paused ? "Resume workspace" : "Pause all", paused ? "resume-all" : "pause-all", "", paused ? "soft" : "", "" + (paused ? "play" : "pause"))}</div></div><main id="main" tabindex="-1">${d.facebook?.status === "reconnect_required" ? `<div class="notice warn">${icon("connections")}<span>${esc(d.facebook.reason)} Existing Meta delivery may continue until pause requests are confirmed.</span><button class="btn tiny" data-action="facebook-connect">Reconnect</button></div>` : ""}${paused ? `<div class="notice warn">${icon("pause")}<span>${d.settings.emergencyPending ? "Pause requests are still being retried with Meta. Delivery may continue until Meta confirms them." : "The workspace is paused. Resume it and enable a brand to continue autonomous work."}</span></div>` : ""}${!state.online ? `<div class="notice error">${icon("info")}Connection interrupted. Showing the last received data.</div>` : ""}${{ overview, brands, campaigns, funnels, creatives, engagement, intelligence, agents, roi, learning, usage, connections }[page]()}<footer class="footer-note"><span>${icon("shield", 12)} Yours to direct. Built to work quietly.</span><span>Spend Control · Meta workspace</span></footer></main></div></div>`;
  app.querySelectorAll("[data-run-detail]").forEach(el => { el.open = expandedRuns.has(el.dataset.runDetail); });
  $(".sidebar").inert = window.innerWidth <= 760;
  if (
    page === "funnels" &&
    !state.plans &&
    !state.loadingPlans &&
    d.brands.length
  )
    void loadPlans();
}
function onboarding() {
  return `<div class="onboard"><div><div class="eyebrow">Room for better decisions</div><h2>A little less managing.<br>A little more growing.</h2><p>Give your brand a clear brief, choose its boundaries, and let the workflow take care of the details.</p><div class="heading-actions">${btn("Add your first brand", "new-brand", "", "primary", "plus")}${btn("Explore a simulation", "demo")}</div></div><div class="steps">${[
    [
      "Connect your accounts",
      "Meta, OpenAI, and your preferred video provider.",
    ],
    [
      "Give your brand a direction",
      "Approved claims, a conversion goal, and a considered budget.",
    ],
    ["Let the work begin", "Generate, review, publish, measure, and improve."],
  ]
    .map(
      (x, i) =>
        `<div class="step"><span class="step-num">${i + 1}</span><div><h3>${x[0]}</h3><p>${x[1]}</p></div></div>`,
    )
    .join("")}</div></div>`;
}
function stat(label, value, foot, glyph) {
  return `<article class="stat"><div class="stat-top">${label}${icon(glyph, 17)}</div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></article>`;
}
function overview() {
  const d = state.data,
    m = metrics(),
    spend = m.reduce((s, x) => s + x.spendMinor, 0),
    conversions = m.reduce((s, x) => s + x.conversions, 0),
    revenue = m.reduce((s, x) => s + x.revenueMinor, 0),
    active = filterItems(d.runs).filter(
      (r) =>
        r.stages.some((s) => s.active) &&
        (!state.currency || brandBy(r.brandId)?.currency === state.currency) &&
        (isSimulation() ? r.mode === "SIMULATE" : r.mode !== "SIMULATE"),
    ).length;
  const actions = `<select id="currency-filter" aria-label="Reporting currency">${[...new Set(d.brands.map((b) => b.currency))].map((c) => `<option ${c === state.currency ? "selected" : ""}>${esc(c)}</option>`).join("") || "<option>Currency</option>"}</select>${btn("New campaign", "new-run", "", "primary", "plus")}`;
  return (
    heading(
      "A clear view of what’s working.",
      "Your advertising, with a little more perspective.",
      actions,
      "Your overview",
    ) +
    (!d.brands.length ? onboarding() : "") +
    (isSimulation()
      ? `<div class="notice">${icon("info")}<span>Simulation workspace. Reporting is illustrative; no advertising or generation costs are incurred.</span></div>`
      : "") +
    `<section class="stats" aria-label="Performance summary">${stat("Advertising spend", m.length ? esc(money(spend)) : "—", `Last ${state.days} days · ${esc(state.currency || "account currency")}`, "money")}${stat("Reported results", m.length ? num(conversions) : "—", "Includes the result objective of each stage", "target")}${stat("Return on ad spend", spend && revenue ? `${num(revenue / spend)}<span class="unit">×</span>` : "—", "Based on reported conversion value", "learning")}${stat("Active campaigns", String(active), `${filterItems(d.creatives).length} creatives in your library`, "campaigns")}</section><div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><h2>Performance, over time</h2><p>${esc(isSimulation() ? "Illustrative reporting" : state.currency ? `Reported in ${state.currency}` : "Connect a brand to begin reporting")}</p></div><div class="segmented">${[7, 14, 28].map((n) => `<button data-action="days" data-id="${n}" class="${n === state.days ? "selected" : ""}">${n}D</button>`).join("")}</div></div><div class="panel-body"><div class="chart-legend"><span class="legend-line"></span>${state.metric === "spendMinor" ? "Advertising spend" : "Reported results"}<button class="btn text tiny" data-action="chart-metric">Switch to ${state.metric === "spendMinor" ? "results" : "spend"}</button></div>${chart(m)}</div></section><section class="panel"><div class="panel-head"><div><h2>Working in the background</h2><p>The latest from your workspace</p></div>${icon("spark", 18)}</div><div class="panel-body">${activityRows(d.activity.filter((x) => !state.brand || x.brandId === state.brand || !x.brandId).slice(0, 4))}</div><div class="panel-foot"><span>${d.worker.pending} pending jobs</span><a href="#learning">View activity ${icon("arrow", 12)}</a></div></section></div><section class="panel"><div class="panel-head"><div><h2>Your brands</h2><p>One workspace. A distinct direction for each brand.</p></div><a class="small" href="#brands">View all ${icon("arrow", 12)}</a></div>${brandTable()}</section>`
  );
}
function chart(rows) {
  if (!rows.length)
    return empty(
      "Your next chapter starts here.",
      "Performance appears after the first campaign reports results.",
      "",
      "learning",
    );
  const series = Array.from({ length: state.days }, (_, i) => {
    const day = new Date(Date.now() - (state.days - 1 - i) * 86400000)
      .toISOString()
      .slice(0, 10);
    return {
      day,
      value: rows
        .filter((r) => r.date === day)
        .reduce((s, r) => s + (r[state.metric] ?? 0), 0),
    };
  });
  const max = Math.max(1, ...series.map((x) => x.value)) * 1.15,
    w = 620,
    h = 220,
    left = 50,
    right = 12,
    top = 12,
    bottom = 34;
  const x = (i) => left + (i * (w - left - right)) / (series.length - 1),
    y = (v) => h - bottom - (v / max) * (h - top - bottom);
  const line = series
    .map(
      (s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.value).toFixed(1)}`,
    )
    .join(" ");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${state.days}-day ${state.metric === "spendMinor" ? "spend" : "results"} trend"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#244ce0" stop-opacity=".1"/><stop offset="100%" stop-color="#244ce0" stop-opacity="0"/></linearGradient></defs>${[0, 0.25, 0.5, 0.75, 1].map((r) => `<path d="M${left} ${y(max * r)}H${w - right}" stroke="#eef0f4" stroke-dasharray="3 4"/><text x="${left - 9}" y="${y(max * r) + 3}" text-anchor="end">${num((max * r) / (state.metric === "spendMinor" ? offset(state.currency) : 1))}</text>`).join("")}<path d="${line}L${x(series.length - 1)},${h - bottom}L${left},${h - bottom}Z" fill="url(#chart-fill)"/><path d="${line}" stroke="#244ce0" stroke-width="2.5" fill="none" stroke-linejoin="round"/>${series.map((s, i) => `<circle cx="${x(i)}" cy="${y(s.value)}" r="3" fill="#fff" stroke="#244ce0" stroke-width="1.5"><title>${esc(s.day)}: ${esc(state.metric === "spendMinor" ? money(s.value) : num(s.value))}</title></circle>${i % Math.max(1, Math.floor(state.days / 6)) === 0 ? `<text x="${x(i)}" y="${h - 9}" text-anchor="middle">${new Date(s.day).toLocaleDateString("en", { month: "short", day: "numeric" })}</text>` : ""}`).join("")}</svg>`;
}
function activityRows(items) {
  return items.length
    ? items
        .map(
          (a) =>
            `<div class="list-row"><div class="row-icon ${esc(a.kind)}">${icon(a.kind === "success" ? "check" : a.kind === "error" ? "info" : a.kind === "warning" ? "clock" : "spark", 14)}</div><div class="list-text"><strong>${esc(a.title)}</strong><p>${esc(a.detail).slice(0, 250)}</p></div><span class="list-time">${time(a.createdAt)}</span></div>`,
        )
        .join("")
    : '<p class="muted small">Activity will appear here as your workspace starts working.</p>';
}
function displayedDailyBudget(b) {
  const stages = state.data.runs.filter(r => r.brandId === b.id && r.mode === b.mode)
    .flatMap(r => r.stages).filter(s => s.active || s.activationPending);
  return { minor: stages.length ? stages.reduce((sum, s) => sum + s.dailyBudgetMinor, 0) : b.spend.dailyBudgetMinor,
    label: stages.length ? "Active daily budget" : "Starting daily budget" };
}
function brandTable() {
  const rows = selectedBrands();
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>Brand</th><th>Mode</th><th>Daily budget</th><th>Funnel</th><th>Autonomy</th><th></th></tr></thead><tbody>${rows.map((b) => `<tr><td><div class="cell-brand">${symbol(b)}<div><strong>${esc(b.name)}</strong><span class="sub">${esc(goalNames[b.archetype])}</span></div></div></td><td>${modeBadge(b.mode)}</td><td>${esc(money(displayedDailyBudget(b).minor, b.currency))}<span class="sub">${displayedDailyBudget(b).label} · ${esc(money(b.spend.maxDailyBudgetMinor, b.currency))} ceiling</span></td><td>${esc(b.funnel === "auto" ? "Recommended" : state.data.funnels[b.funnel]?.name)}</td><td>${badge(b.autonomy ? "Enabled" : "Paused", b.autonomy ? "green" : "")}</td><td>${btn("Manage", "edit-brand", b.id, "tiny", "arrow")}</td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "A home for every brand.",
        "Add a brand to start planning its next campaign.",
        btn("Add a brand", "new-brand", "", "primary", "plus"),
        "brands",
      );
}
function brands() {
  return (
    heading(
      "Every brand, considered.",
      "A clear brief and clear boundaries for each business.",
      btn("Add a brand", "new-brand", "", "primary", "plus"),
    ) +
    (!state.data.brands.length
      ? onboarding()
      : `<div class="brand-grid">${selectedBrands()
          .map(
            (b) =>
              `<article class="panel brand-card"><div class="brand-card-head">${symbol(b)}${modeBadge(b.mode)}</div><h3>${esc(b.name)}</h3><p>${esc(goalNames[b.archetype])}</p><p class="brand-summary">${esc(b.proposition)}</p><div class="brand-budget"><div><strong>${esc(money(displayedDailyBudget(b).minor, b.currency))}</strong><span>${displayedDailyBudget(b).label}</span></div><div><strong>${esc(money(b.spend.targetCpaMinor, b.currency))}</strong><span>Target cost per result</span></div></div>${badge(b.autonomy ? "Autonomy enabled" : "Autonomy paused", b.autonomy ? "green" : "")}${b.preflight.some((c) => c.severity === "BLOCK") ? " " + badge("Check connection", "red") : ""}<p class="small muted">Production today: $${(state.data.productionSpend[b.id] ?? 0).toFixed(2)} / $${b.generationDailyUsd}</p><div class="heading-actions">${btn("Edit", "edit-brand", b.id, "tiny", "edit")}${btn("Check", "check-brand", b.id, "tiny", "shield")}${btn(b.autonomy ? "Pause" : "Enable", "toggle-brand", b.id, b.autonomy ? "tiny" : "tiny soft", b.autonomy ? "pause" : "play")}${btn("Run", "run", b.id, "tiny", "arrow")}</div></article>`,
          )
          .join("")}</div>`)
  );
}
const phaseIds = [
  "plan",
  "copy",
  "generate",
  "poll",
  "assemble",
  "screen",
  "audiences",
  "publish",
  "activate",
];
const phaseLabels = [
  "Plan",
  "Write",
  "Generate",
  "Collect",
  "Assemble",
  "Review",
  "Audiences",
  "Publish",
  "Activate",
];
function campaigns() {
  const runs = filterItems(state.data.runs).filter(
    (r) =>
      state.runFilter === "all" ||
      (state.runFilter === "attention"
        ? r.status === "blocked"
        : state.runFilter === "active"
          ? r.stages.some((s) => s.active)
          : r.mode === "STAGE"),
  );
  return (
    heading(
      "Good work, in motion.",
      "Follow every campaign from the first brief to its next decision.",
      btn("New campaign", "new-run", "", "primary", "plus"),
    ) +
    `<div class="filter-tabs">${[
      ["all", "All campaigns"],
      ["active", "Active"],
      ["attention", "Needs attention"],
      ["staged", "Paused staging"],
    ]
      .map(
        ([id, label]) =>
          `<button data-action="run-filter" data-id="${id}" class="${state.runFilter === id ? "active" : ""}">${label}</button>`,
      )
      .join("")}</div>` +
    (runs.length
      ? runs
          .map((r) => {
            const b = brandBy(r.brandId),
              index = r.phase === "complete" ? 9 : phaseIds.indexOf(r.phase);
            return `<article class="panel run-card"><div class="run-top"><div class="run-title">${symbol(b)}<div><h3>${esc(b?.name ?? r.brandId)} <span class="muted small">/ ${esc(r.id.slice(0, 8))}</span></h3><p>${esc(r.plan?.template?.name ?? "Planning campaign")} · ${time(r.createdAt)} · ${r.creativeIds.length} creatives</p></div></div><div>${modeBadge(r.mode)} ${statusBadge(r.status)}</div></div><div class="pipeline" aria-label="Campaign progress">${phaseLabels.map((label, i) => `<div class="pipeline-step ${i < index ? "done" : i === index ? (r.status === "blocked" ? "failed" : "current") : ""}"><div class="track"></div><span>${label}</span></div>`).join("")}</div>${r.error ? `<div class="notice error">${icon("info")}<span>${esc(r.error)}</span></div>` : ""}<div class="run-bottom"><span>${r.mode === "SIMULATE" ? "No real spend" : `Video production estimate: $${r.generationCostUsd.toFixed(2)}`} · ${r.stages.length} ${r.stages.length === 1 ? "stage" : "stages"} ${r.nextAt ? `· Next step ${time(r.nextAt)}` : ""}</span><div class="heading-actions">${r.mode !== "SIMULATE" ? btn("View costs", "usage-run", r.id, "tiny", "money") : ""}${r.status === "blocked" ? btn("Retry step", "retry-run", r.id, "tiny soft", "refresh") : ""}${r.status !== "cancelled" ? btn("Pause brand", "pause-run", r.id, "tiny", "pause") : ""}</div></div>${r.stages.length || r.warnings.length ? `<details class="run-detail" data-run-detail="${esc(r.id)}"><summary>Campaign details & checks</summary>${r.warnings.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}${r.stages.map((s) => `<p>${esc(human(s.stageId))} · ${esc(money(s.dailyBudgetMinor, b.currency))}/day · ${s.active ? "Active" : "Paused"} · ${esc(human(s.primaryAction.replace(/^offsite_conversion\.(fb_pixel_)?/, "").replace(/^onsite_conversion\./, "")))}</p>`).join("")}</details>` : ""}</article>`;
          })
          .join("")
      : empty(
          "A considered start.",
          "Create a campaign or enable brand autonomy to begin.",
          btn("New campaign", "new-run", "", "primary", "plus"),
          "campaigns",
        ))
  );
}
async function loadPlans() {
  const id = state.funnelBrand || state.brand || state.data.brands[0]?.id;
  if (!id) return;
  state.funnelBrand = id;
  state.loadingPlans = true;
  try {
    const p = await api(`/brands/${id}/plan`);
    if (state.funnelBrand === id) state.plans = p;
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.loadingPlans = false;
    if (currentPage() === "funnels") render();
  }
}
function funnels() {
  const choices = state.data.brands
    .map(
      (b) =>
        `<option value="${esc(b.id)}" ${b.id === (state.funnelBrand || state.brand || state.data.brands[0]?.id) ? "selected" : ""}>${esc(b.name)}</option>`,
    )
    .join("");
  return (
    heading(
      "The right shape for your growth.",
      "Five thoughtful strategies. Choose one, or let the planner recommend a fit.",
    ) +
    `<div class="funnel-intro"><p class="muted small">Compare budget concentration, audience needs, and the job of each stage.</p>${choices ? `<select id="funnel-brand" aria-label="Plan for brand">${choices}</select>` : btn("Add a brand to compare", "new-brand", "", "primary", "plus")}</div>${state.plans ? `<div class="notice">${icon("spark")}<span>Recommended: <strong>${esc(state.plans.selected.recommendation.templateId ? state.data.funnels[state.plans.selected.recommendation.templateId]?.name : "Single Engine")}</strong>. Planning benchmarks are estimates; actual results determine ongoing decisions.</span></div>` : ""}<div class="funnel-grid">${Object.values(
      state.data.funnels,
    )
      .map((f, i) => {
        const p = state.plans?.options.find((x) => x.templateId === f.id);
        let cumulative = 0;
        return `<article class="panel funnel-card ${state.plans?.selected.templateId === f.id ? "chosen" : ""}"><div class="funnel-number">0${i + 1} ${state.plans?.selected.templateId === f.id ? "· SELECTED" : ""}</div><h3>${esc(f.name)}</h3><p>${esc(funnelDescriptions[f.id])}</p><div><div class="funnel-visual"><svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-label="Budget allocation">${f.stages
          .map((s, j) => {
            const x = cumulative;
            cumulative += s.budgetShare * 100;
            return `<rect x="${x}" y="0" width="${s.budgetShare * 100 - 0.8}" height="8" fill="${["#244ce0", "#8fa6f1", "#cbd6f5"][j % 3]}"/>`;
          })
          .join(
            "",
          )}</svg></div>${f.stages.map((s) => `<div class="funnel-stage"><span class="dot"></span><span>${esc(s.label)}</span><span class="stage-share">${Math.round(s.budgetShare * 100)}%</span></div>`).join("")}</div>${p ? `<div class="${p.refusal ? "funnel-unavailable" : "funnel-available"}">${p.refusal ? esc(p.refusal) : "Available for this brand’s budget and audience history."}</div>` : `<p>${f.requiresWarmPool ? num(f.requiresWarmPool) + " people in a warm audience" : "No existing warm audience required"}</p>`}${btn("Explore this funnel", "funnel-detail", f.id, "", "arrow")}</article>`;
      })
      .join("")}</div>`
  );
}
function creatives() {
  const list = filterItems(state.data.creatives).filter(
    (c) =>
      state.creativeFilter === "all" ||
      (state.creativeFilter === "approved"
        ? ["passed", "published"].includes(c.status)
        : c.status === "blocked"),
  );
  return (
    heading(
      "Ideas, made tangible.",
      "Every angle, film, and quality check in one place.",
      btn("Create a campaign", "new-run", "", "primary", "plus"),
    ) +
    `<div class="filter-tabs">${[
      ["all", "All creatives"],
      ["approved", "Approved"],
      ["blocked", "Needs attention"],
    ]
      .map(
        ([id, label]) =>
          `<button data-action="creative-filter" data-id="${id}" class="${state.creativeFilter === id ? "active" : ""}">${label}</button>`,
      )
      .join("")}</div>` +
    (list.length
      ? `<div class="creative-grid">${list.map((c) => `<button class="creative-card" data-action="creative-detail" data-id="${c.id}"><div class="creative-art">${c.thumbnail ? `<img src="${esc(c.thumbnail)}" loading="lazy" alt="${esc(c.headline)}">` : icon("creatives", 36)}${statusBadge(c.status)}${c.media ? `<span class="creative-play">${icon("play", 13)}</span>` : ""}</div><div class="creative-info"><h3>${esc(c.headline)}</h3><p>${esc(brandBy(c.brandId)?.name)} · ${esc(c.angle)}</p><div class="creative-meta"><span>${esc(human(c.genome.template))}</span><span>16s · ${c.variants.length} formats</span></div></div></button>`).join("")}</div>`
      : empty(
          "Your next idea lives here.",
          "Start a campaign to generate distinct creative angles, narration, and videos.",
          btn("New campaign", "new-run", "", "primary", "plus"),
          "creatives",
        ))
  );
}
function decisionSummary(d) {
  if (d.action === "BUDGET" && d.valueMinor != null)
    return `${d.applied ? "Daily budget updated to" : "Daily budget proposed at"} ${money(d.valueMinor, brandBy(d.brandId)?.currency)}.`;
  if (d.action === "HOLD" && /LEARNING/.test(d.reason)) return "Learning is still in progress. Keep delivery steady while results settle.";
  if (/ROAS/.test(d.reason) && /hold|below|not met/i.test(d.reason)) return "Return on ad spend does not yet support a budget increase.";
  if (d.action === "KILL") return "The settled evidence supports pausing this creative and keeping the stronger alternative.";
  if (d.action === "SCALE") return d.applied ? "The stronger creative qualified for a measured budget increase." : "A stronger creative was identified. The spending gates determine whether its budget can change.";
  if (d.action === "EQUIVALENT") return "These creatives perform similarly. Keep collecting results.";
  return d.reason;
}
const decisionLabels = { KILL: "Pause creative", BUDGET: "Budget", SCALE: "Scale", HOLD: "Hold", PAUSE: "Pause brand", EQUIVALENT: "Similar results", ITERATE: "New direction" };
function learning() {
  const decisions = filterItems(state.data.decisions);
  return (
    heading(
      "Every decision has a reason.",
      "See what the system learns, changes, and leaves to gather more evidence.",
      `<a class="btn" href="/api/export?kind=metrics${state.brand ? `&brand=${encodeURIComponent(state.brand)}` : ""}">${icon("down", 15)}Export reporting</a>`,
    ) +
    `<div class="learning-layout"><section class="panel"><div class="panel-head"><div><h2>Optimization decisions</h2><p>Mature evidence, measured changes.</p></div>${icon("learning")}</div>${decisions.length ? decisions.map((d) => `<article class="learning-row"><header><strong class="small">${esc(brandBy(d.brandId)?.name)}</strong>${badge(decisionLabels[d.action] ?? human(d.action), d.action === "SCALE" ? "green" : d.action === "KILL" ? "red" : "blue")}</header><p>${esc(decisionSummary(d))}</p>${decisionSummary(d) !== d.reason ? `<details class="decision-evidence" data-run-detail="decision:${esc(d.id)}"><summary>Decision evidence</summary><p>${esc(d.reason)}</p></details>` : ""}<small>${time(d.createdAt)} · ${d.simulation ? "Illustrative simulation" : d.applied ? "Applied to Meta" : "Observed · no change applied"} · ${esc(d.adId.slice(-10))}</small></article>`).join("") : empty("Learning needs a little time.", "Decisions appear after reporting provides enough settled evidence.", "", "learning")}</section><section class="panel"><div class="panel-head"><div><h2>Workspace activity</h2><p>A record of the work behind the scenes.</p></div>${icon("clock")}</div><div class="panel-body">${activityRows(state.data.activity.filter((x) => !state.brand || x.brandId === state.brand || !x.brandId))}</div></section></div>`
  );
}
function field(name, label, value = "", opts = {}) {
  const id = `f-${name.replace(/[^a-z0-9-]/gi, "-")}`;
  let control;
  const attrs = `id="${id}" name="${esc(name)}" ${opts.required ? "required" : ""} ${opts.disabled ? "disabled" : ""} ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ""}`;
  if (opts.options)
    control = `<select ${attrs}>${opts.options
      .map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(v)}" ${String(value) === String(v) ? "selected" : ""}>${esc(l)}</option>`;
      })
      .join("")}</select>`;
  else if (opts.area)
    control = `<textarea ${attrs} rows="${opts.rows ?? 3}">${esc(value)}</textarea>`;
  else
    control = `<input ${attrs} type="${opts.type ?? "text"}" value="${opts.type === "password" ? "" : esc(value)}" ${opts.min !== undefined ? `min="${opts.min}"` : ""} ${opts.step ? `step="${opts.step}"` : ""} ${opts.type === "password" ? 'autocomplete="new-password"' : opts.autocomplete ? `autocomplete="${opts.autocomplete}"` : ""}>`;
  return `<div class="field ${opts.full ? "full" : ""}"><label for="${id}">${esc(label)}</label>${control}${opts.help ? `<small>${esc(opts.help)}</small>` : ""}</div>`;
}
function secret(name, label, help = "") {
  return field(name, label, "", {
    type: "password",
    full: true,
    placeholder: state.data.connections[name]
      ? "Connected · leave blank to keep"
      : "Enter credential",
    help,
  });
}
function facebookPanel() {
  const f = state.data.facebook;
  const connected = f.status === "connected";
  const expiry = [f.expiresAt, f.dataAccessExpiresAt].filter(Boolean).sort((a,b) => a-b)[0];
  const selected = f.selection;
  return `<section class="panel connection facebook-connection"><div class="connection-title"><div class="service facebook-mark">f</div><h3>Facebook & Instagram</h3>${badge(connected ? "Connected" : f.status === "reconnect_required" ? "Reconnect needed" : "Not connected", connected ? "green" : "amber")}</div><p>${connected ? `Connected ${f.method === "oauth" ? `as <strong>${esc(f.name)}</strong>` : "with a system-user authorization"}. Choose the assets your workspace can manage.` : "Sign in with Facebook to discover your ad accounts, Pages, and connected Instagram accounts."}</p>${f.reason ? `<div class="notice ${f.status === "reconnect_required" ? "warn" : ""}">${icon("info")}<span>${esc(f.reason)}</span></div>` : ""}<div class="facebook-actions">${f.configured ? btn(f.linked ? "Reconnect Facebook" : "Connect Facebook", "facebook-connect", "", "primary", "connections") : '<a class="btn primary" href="/meta-setup" target="_blank" rel="noopener">Facebook setup guide</a>'}${connected ? btn("Choose accounts & Pages", "discover", "", "", "brands") : ""}</div>${connected ? `<div class="connection-summary"><div><strong>${selected.accountIds.length}</strong><span>Selected accounts</span></div><div><strong>${selected.pageIds.length}</strong><span>Selected Pages</span></div></div>` : ""}${expiry ? `<p class="small muted">Reconnect before ${esc(new Date(expiry).toLocaleDateString(undefined, {year:"numeric",month:"short",day:"numeric"}))}. Background work uses the securely stored authorization.</p>` : ""}${f.method === "oauth" ? `<details class="form-section"><summary>Authorized permissions</summary><div class="permission-list">${Object.entries(f.permissionLabels).map(([key,label]) => `<div><span class="dot ${f.permissions.includes(key) ? "" : "paused"}"></span><span>${esc(label)}</span>${badge(f.permissions.includes(key) ? "Granted" : "Not granted", f.permissions.includes(key) ? "green" : "")}</div>`).join("")}</div><p class="small muted">Available assets depend on the permissions granted to this app and your role in each business.</p></details>` : ""}<details class="form-section" id="facebook-setup" ${!f.configured ? "open" : ""}><summary>One-time app setup</summary><p class="small muted">Register one Meta app for this workspace. Use a Facebook Login for Business configuration that issues a User access token.</p><form data-form="facebook-config"><div class="form-error" role="alert"></div><div class="form-grid">${field("appId","Meta app ID","",{full:true,placeholder:state.data.connections.metaAppId ? "Saved · leave blank to keep" : "App ID"})}${field("appSecret","App secret","",{full:true,type:"password",placeholder:state.data.connections.metaAppSecret ? "Saved securely · leave blank to keep" : "App secret"})}${field("configId","Login configuration ID","",{full:true,placeholder:f.configured ? "Saved · leave blank to keep" : "User access token configuration"})}</div><div class="form-footer"><a class="btn tiny" href="/meta-setup" target="_blank" rel="noopener">Setup guide</a><button class="btn primary">Save app setup</button></div></form><div class="eyebrow mt">Facebook redirect URL</div><div class="code break-url">${esc(f.callbackUrl || "Set APP_ORIGIN on the server first")}</div><p class="small muted">Your app secret stays encrypted on the server.</p></details><details class="form-section"><summary>Advanced: system-user connection</summary><p class="small muted">An alternative for assigned business assets. Facebook can still be used for owner sign-in.</p><form data-form="connections"><div class="form-error" role="alert"></div>${secret("metaToken", "System user access token")}<div class="form-footer"><button class="btn">Save system-user token</button></div></form></details>${connected ? `<div class="form-footer">${btn("Disconnect advertising", "facebook-disconnect", "", "tiny")}</div>` : ""}</section>`;
}
function assetPicker(assets) {
  state.assetInventory = assets;
  const selected = state.data.facebook.selection;
  const group = (items, name, ids, headingText) => `<section><div class="asset-heading"><h3>${headingText}</h3><button type="button" class="btn tiny" data-action="select-assets" data-id="${name}">Select all</button></div>${items.length ? items.map(item => `<label class="asset-choice" data-search="${esc(`${item.name || ""} ${item.id}`.toLowerCase())}"><input type="checkbox" name="${name}" value="${esc(item.id)}" ${ids.includes(item.id) ? "checked" : ""}><span><strong>${esc(item.name || item.id)}</strong><small>${esc(item.id)}${item.currency ? ` · ${esc(item.currency)}` : ""}${item.timezone_name ? ` · ${esc(item.timezone_name)}` : ""}${item.instagram_business_account ? ` · Instagram ${esc(item.instagram_business_account.username || item.instagram_business_account.id)}` : ""}</small></span></label>`).join("") : `<p class="muted small">No ${headingText.toLowerCase()} were returned. Check your asset access and Facebook permissions, then reconnect.</p>`}</section>`;
  modal("Choose your accounts & Pages", "Connect the assets this workspace should manage. This does not start advertising.", `<form data-form="facebook-assets"><div class="form-error" role="alert"></div>${assets.warnings?.length ? `<div class="notice warn"><span>${assets.warnings.map(esc).join("<br>")}</span></div>` : ""}${field("assetSearch","Find an account or Page","",{full:true,placeholder:"Search by name or ID"})}<div class="asset-columns">${group(assets.accounts,"accountIds",selected.accountIds,"Ad accounts")}${group(assets.pages,"pageIds",selected.pageIds,"Facebook Pages")}</div>${assets.businesses?.length ? `<p class="small muted mt">Business portfolios: ${assets.businesses.map(b=>esc(b.name || b.id)).join(", ")}</p>` : ""}<div class="form-footer">${btn("Cancel","close")}<button class="btn primary">Save selected assets</button></div></form>`);
}
function assetOptions(items, selected, label) {
  const options = [["",label],...items.map(a=>[a.id,`${a.name || a.username || a.id} · ${a.id}`])];
  if (selected && !items.some(a=>a.id===selected)) options.push([selected,`${selected} · check access`]);
  return options;
}
function brandAssetFields(v,dest) {
  const f = state.data.facebook, assets = state.data.metaAssets;
  if (!assets) return `${field("pageId","Facebook Page ID",v.pageId,{help:"Connect Facebook to choose Pages by name. Optional in simulation."})}${field("adAccountId","Ad account ID",v.adAccountId,{placeholder:"act_123456789"})}${field("instagramUserId","Instagram account ID",v.instagramUserId)}${field("pixelId","Pixel / dataset ID",dest.pixelId)}`;
  const accounts = assets.accounts.filter(a=>f.method!=="oauth" || f.selection.accountIds.includes(a.id));
  const pages = assets.pages.filter(a=>f.method!=="oauth" || f.selection.pageIds.includes(a.id));
  return `${field("adAccountId","Ad account",v.adAccountId,{options:assetOptions(accounts,v.adAccountId,"Choose an ad account")})}${field("pageId","Facebook Page",v.pageId,{options:assetOptions(pages,v.pageId,"Choose a Page")})}${field("instagramUserId","Instagram account",v.instagramUserId,{options:assetOptions(pages.flatMap(p=>p.instagram_business_account ? [p.instagram_business_account] : []),v.instagramUserId,"No Instagram account")})}${field("pixelId","Pixel / dataset",dest.pixelId,{options:assetOptions([],dest.pixelId,"Choose an account to load pixels")})}<div class="field full"><button type="button" class="btn tiny" data-action="brand-assets">Refresh connected assets</button><p class="small muted" id="brand-asset-status" role="status">Your account currency and timezone update when you choose an account. Review the budget before saving.</p></div>`;
}
async function loadBrandAssets(form) {
  const account = form.elements.adAccountId.value, page = form.elements.pageId.value;
  const status = $("#brand-asset-status", form);
  if (!account || !state.data.metaAssets) return;
  if (status) status.textContent = "Loading connected assets…";
  try {
    const result = await api(`/meta/assets/details?account=${encodeURIComponent(account)}&page=${encodeURIComponent(page)}`);
    if (!form.isConnected || form.elements.adAccountId.value !== account || form.elements.pageId.value !== page) return;
    for (const [name,items,label] of [["pixelId",result.pixels,"No pixel selected"],["instagramUserId",result.instagram,"No Instagram account"],["leadFormId",result.forms,"Create a new form / no form selected"]]) {
      const old = form.elements[name];
      const value = old.value;
      const select = document.createElement("select"); select.name = name; select.id = old.id;
      select.innerHTML = assetOptions(items,value,label).map(([id,text])=>`<option value="${esc(id)}" ${id===value ? "selected" : ""}>${esc(text)}</option>`).join("");
      old.replaceWith(select);
    }
    if (status) status.textContent = result.warnings.length ? result.warnings.join(" ") : `${result.pixels.length} pixels, ${result.instagram.length} Instagram accounts, ${result.forms.length} lead forms, ${result.audiences.length} audiences, and ${result.apps.length} apps available.`;
  } catch (error) { if (status) status.textContent = error.message; }
}
async function startFacebook(intent, details = {}) {
  const result = await api("/meta/oauth/start", "POST", {intent,...details});
  location.assign(result.url);
}

function connections() {
  const d = state.data,
    s = d.settings,
    c = d.connections;
  return (
    heading(
      "Everything, connected.",
      "A few considered connections power the whole workflow.",
      btn("Check connections", "check-connections", "", "", "shield"),
    ) +
    `<div class="connection-grid">${facebookPanel()}${engagementConnections()}<form class="panel connection" data-form="connections"><div class="connection-title"><div class="service">${icon("spark", 22)}</div><h3>OpenAI</h3>${badge(c.openaiKey ? "Credentials saved" : "Not connected", c.openaiKey ? "green" : "")}</div><p>Writes grounded scripts, produces narration, and reviews the rendered films against the brand brief.</p><div class="form-error" role="alert"></div><div class="form-grid">${secret("openaiKey", "API key")}${field("textModel", "Text & vision model", s.textModel, { full: true, required: true })}${field("textInputUsdPerMillion", "Input price / 1M tokens (USD)", s.textInputUsdPerMillion, { type: "number", min: 0.01, step: ".01" })}${field("textCachedUsdPerMillion", "Cached input price / 1M tokens (USD)", s.textCachedUsdPerMillion ?? 0.1, { type: "number", min: 0, step: ".01" })}${field("textOutputUsdPerMillion", "Output price / 1M tokens (USD)", s.textOutputUsdPerMillion, { type: "number", min: 0.01, step: ".01" })}</div><div class="form-footer"><button class="btn primary">Save OpenAI connection</button></div><div class="secret-note">${icon("info", 12)} Keep model rates current for production cost reservations.</div></form><form class="panel connection" data-form="connections"><div class="connection-title"><div class="service">${icon("creatives", 21)}</div><h3>Video generation</h3>${badge(c[s.provider === "minimax" ? "minimaxKey" : s.provider === "seedance" ? "seedanceKey" : "googleServiceAccount"] ? "Credentials saved" : "Not connected", c[s.provider === "minimax" ? "minimaxKey" : s.provider === "seedance" ? "seedanceKey" : "googleServiceAccount"] ? "green" : "")}</div><p>MiniMax H3 generates at 768P for $0.08 per second at the published rate. Two 8-second shots cost $1.28 before copy, narration, and review. Each brand’s production allowance limits new requests.</p><div class="form-error" role="alert"></div><div class="form-grid">${field(
      "provider",
      "Provider",
      s.provider,
      {
        options: [
          ["minimax", "MiniMax H3 · 768P"],
          ["seedance", "Seedance · BytePlus"],
          ["veo", "Veo · Google Cloud"],
        ],
        full: true,
      },
    )}${field("videoModel", "Video model ID", s.videoModel, { full: true, required: true })}${secret("minimaxKey", "MiniMax pay-as-you-go API key", "Shared with MiniMax engagement models. A subscription or coding-plan key does not cover H3 video.")}${field("h3UsdPerSecond", "H3 768P price per second (USD)", s.h3UsdPerSecond ?? 0.08, {type:"number",min:0.000001,step:"0.000001",help:"Default $0.08. Captured on each request; changing it affects future generations."})}${secret("seedanceKey", "Seedance API key")}${field("googleServiceAccount", "Google service account JSON", "", { area: true, full: true, placeholder: c.googleServiceAccount ? "Connected · leave blank to keep" : "Paste the service account JSON securely" })}${field("googleProject", "Google Cloud project", s.googleProject)}${field("googleRegion", "Region", s.googleRegion)}${field("googleBucket", "Output bucket URI", s.googleBucket, { full: true, placeholder: "gs://your-bucket/generated/" })}</div><div class="form-footer"><button class="btn primary">Save video provider</button></div></form><form class="panel connection" data-form="connections"><div class="connection-title"><div class="service">${icon("connections", 21)}</div><h3>Feedback & delivery</h3>${badge("Optional")}</div><p>Send consented website conversions back to Meta and deliver incoming form leads to your CRM.</p><div class="form-error" role="alert"></div><div class="form-grid">${secret("conversionWebhookToken", "Conversion webhook bearer token", "Choose a long random secret and use it in your website’s server integration.")}${secret("leadWebhookSecret", "CRM webhook signing secret", "The receiver verifies X-Signature-SHA256 over timestamp.body and deduplicates X-Event-ID.")}${field("pollMinutes", "Reporting interval (minutes)", s.pollMinutes, { type: "number", min: 15, step: "1", full: true })}</div><div class="code">POST /api/webhooks/conversions</div><div class="form-footer"><a class="btn tiny" href="/api/export?kind=leads">${icon("down", 13)}Export ${d.leadCount} leads</a><button class="btn primary">Save feedback settings</button></div></form></div>`
  );
}
function brandForm(id = "") {
  const b = brandBy(id),
    v = b ?? {},
    sp = b?.spend ?? {},
    dest = b?.destination ?? {},
    claims = b?.claims ?? {},
    curr = v.currency ?? "USD",
    o = offset(curr);
  modal(
    b ? "Edit brand" : "A new direction.",
    b
      ? "Pause active work before changing the brief or budget."
      : "Start with the essentials. You can refine them as your brand grows.",
    `<form data-form="brand" data-id="${esc(id)}"><div class="form-error" role="alert"></div><section class="form-section"><h3>01 / Your brand</h3><div class="form-grid">${field("name", "Brand name", v.name, { required: true, placeholder: "e.g. NORD Objects" })}${field("id", "Brand ID", v.id, { required: true, disabled: !!b, placeholder: "nord-objects", help: "Lowercase letters, numbers, and hyphens." })}${field("proposition", "What do you sell?", v.proposition, { required: true, area: true, full: true, help: "Describe the real product, who it is for, and what makes it useful." })}${field("archetype", "Campaign goal", v.archetype ?? "website_purchase", { options: Object.entries(goalNames) })}${field("language", "Creative language", v.language ?? "English", { required: true })}${field(
      "mode",
      "Operating mode",
      v.mode ?? "SIMULATE",
      {
        options: [
          ["SIMULATE", "Simulation · no external spend"],
          ["STAGE", "Staging · paid generation, paused ads"],
          ["LIVE", "Live · autonomous delivery"],
        ],
      },
    )}${field("countries", "Countries", v.countries?.join(", ") ?? "US", { required: true, help: "Two-letter codes separated by commas." })}</div></section><section class="form-section"><h3>02 / Boundaries & budget</h3><div class="form-grid">${field("currency", "Account currency", curr, { required: true, help: "Use the currency of the connected ad account." })}${field("timezone", "Account timezone", v.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, { required: true })}${field("dailyBudget", "Daily advertising budget", sp.dailyBudgetMinor / o || 100, { required: true, type: "number", min: 0.01, step: ".01" })}${field("maxBudget", "Maximum combined daily budget", sp.maxDailyBudgetMinor / o || 200, { required: true, type: "number", min: 0.01, step: ".01", help: "Limits the configured budgets across managed campaigns. Meta can spend more than a daily budget on an individual day." })}${field("targetCpa", "Target cost per result", sp.targetCpaMinor / o || 20, { required: true, type: "number", min: 0.01, step: ".01" })}${field("generationDailyUsd", "Daily production allowance (USD)", v.generationDailyUsd ?? 15, { required: true, type: "number", min: 0.1, step: ".1" })}${field("lifetimeLimit", "Stop at reported total spend", v.lifetimeLimitMinor / o || 0, { type: "number", min: 0, step: ".01", help: "0 disables this observed-spend stop. Reporting delay can cause overshoot; the Meta account cap is the hard backstop." })}${field("creativesPerCycle", "Creatives per funnel stage", v.creativesPerCycle ?? 3, { options: [1, 2, 3, 4, 5, 6] })}${field("approved", "Approved claims", (claims.substantiated ?? []).join("\n"), { area: true, full: true, required: true, help: "One factual, substantiated claim per line. The creative writer stays within these claims." })}${field("neverSay", "Never say", (claims.neverSay ?? []).join("\n"), { area: true })}${field("neverShow", "Never show", (claims.neverShow ?? []).join("\n"), { area: true })}${field("specialAdCategories", "Special ad category", v.specialAdCategories?.[0] ?? "NONE", { options: ["NONE", "HOUSING", "EMPLOYMENT", "CREDIT", "FINANCIAL_PRODUCTS_SERVICES", "ISSUES_ELECTIONS_POLITICS", "ONLINE_GAMBLING_AND_GAMING"], full: true })}</div></section><section class="form-section"><h3>03 / Where people go</h3><div class="form-grid">${field("url", "Website / destination URL", dest.url, { type: "url", full: true, placeholder: "https://your-brand.com/product" })}${brandAssetFields(v,dest)}${field("customEventType", "Conversion event", dest.customEventType ?? "PURCHASE", { options: ["PURCHASE", "LEAD", "COMPLETE_REGISTRATION", "CONTACT", "SUBSCRIBE", "ADD_TO_CART", "VIEW_CONTENT"] })}${field("leadFormId", "Existing lead form ID", dest.leadFormId)}${field("privacyPolicyUrl", "Privacy policy URL", v.privacyPolicyUrl, { type: "url", full: true, help: "Required to create a new Meta lead form automatically." })}${field("productImage", "Product reference image URL", v.productImage, { type: "url", full: true, help: "A public HTTPS image of your actual product." })}${field("websiteDescription", "Destination context", v.websiteDescription, { area: true, full: true, help: "Describe what visitors will find after clicking the ad." })}</div></section><details class="form-section"><summary>04 / Funnel & audience history</summary><div class="form-grid">${field("funnel", "Funnel strategy", v.funnel ?? "auto", { full: true, options: [["auto", "Recommend for my brand"], ...Object.values(state.data.funnels).map((f) => [f.id, f.name])] })}${field(
      "assets",
      "Existing audience signal",
      v.assets ?? "nothing",
      {
        options: [
          ["nothing", "Starting fresh"],
          ["video_views", "Video engagement"],
          ["website_traffic", "Website traffic"],
          ["customers", "Customer list"],
        ],
      },
    )}${field("warmPoolSize", "Warm audience size", v.warmPoolSize ?? 0, { type: "number", min: 0, step: "1" })}${field("purchasesLast180d", "Purchases in the last 180 days", v.purchasesLast180d ?? 0, { type: "number", min: 0, step: "1" })}${field("targetRoas", "Minimum ROAS before scaling", sp.targetRoas ?? "", { type: "number", min: 0.1, step: ".1" })}${Object.values(
      state.data.audiences,
    )
      .filter((a) => a.kind !== "union")
      .map((a) =>
        field(`audience:${a.id}`, a.label, v.audienceIds?.[a.id] ?? "", {
          help: "Existing Meta audience ID; leave empty for supported automatic creation.",
        }),
      )
      .join(
        "",
      )}</div></details><details class="form-section"><summary>05 / Calls, apps, catalogue & lead delivery</summary><div class="form-grid">${field("phoneNumber", "Phone number", dest.phoneNumber, { placeholder: "+14155551234" })}${field("applicationId", "Meta application ID", dest.applicationId)}${field("objectStoreUrl", "App store URL", dest.objectStoreUrl, { type: "url", full: true })}${field("productSetId", "Product set ID", dest.productSetId)}${field("catalogCreativeId", "Existing catalogue creative ID", v.catalogCreativeId, { help: "A feed-based template creative from this account." })}${field("resultActionType", "Result reporting key", v.resultActionType, { full: true, help: "Required for live phone campaigns: use the verified action_type returned by this account. Optional override for other goals." })}${field("leadWebhookUrl", "CRM webhook URL", v.leadWebhookUrl, { type: "url", full: true })}${field("leadFormLocale", "Lead form language code", v.leadFormLocale ?? "en_US")}${field(
      "attributionClickDays",
      "Click attribution window",
      v.attributionClickDays ?? 7,
      {
        options: [
          [7, "7 days"],
          [1, "1 day"],
        ],
      },
    )}</div></details><div class="form-footer"><span class="muted">Saved brands start with autonomy paused.</span>${btn("Cancel", "close")}<button class="btn primary">${b ? "Save changes" : "Create brand"}</button></div></form>`,
  );
}
function launchDialog(id) {
  const b = brandBy(id);
  if (!b) return;
  modal(
    b.mode === "LIVE"
      ? "Enable live autonomy?"
      : b.mode === "SIMULATE"
        ? "Enable simulation autonomy?"
        : "Run paused staging?",
    b.name,
    `<p class="small muted">${b.mode === "LIVE" ? "The system will generate creatives, publish and activate Meta campaigns, collect results, and make measured changes within these boundaries." : b.mode === "SIMULATE" ? "The full workflow runs with test media and illustrative reporting. No paid providers or Meta campaigns are used." : "Production uses paid providers and creates real Meta objects with delivery paused."}</p><div class="brand-budget"><div><strong>${esc(money(b.spend.dailyBudgetMinor, b.currency))}</strong><span>Daily advertising budget</span></div><div><strong>${esc(money(b.spend.maxDailyBudgetMinor, b.currency))}</strong><span>Configured budget ceiling</span></div><div><strong>$${b.generationDailyUsd}</strong><span>Daily production allowance</span></div></div>${b.mode === "LIVE" ? '<p class="small muted">Meta may spend more than a daily budget on an individual day. An account spending limit must be configured in Meta. You can pause this brand or the whole workspace at any time.</p>' : ""}<div class="form-error" role="alert"></div><div class="form-footer">${btn("Cancel", "close")}${btn(b.mode === "STAGE" ? "Start staging" : b.mode === "LIVE" ? "Enable live autonomy" : "Enable simulation", "confirm-enable", b.id, "primary", "play")}</div>`,
    true,
  );
}
function creativeDetail(id) {
  const c = state.data.creatives.find((c) => c.id === id);
  if (!c) return;
  modal(
    "A closer look.",
    brandBy(c.brandId)?.name,
    `<div class="creative-detail"><div>${c.media ? `<video controls playsinline preload="metadata" poster="${esc(c.thumbnail)}" src="${esc(c.media)}"></video>` : `<div class="empty">${icon("creatives", 40)}<p>Video is still in production.</p></div>`}${c.variants.length ? `<div class="heading-actions mt">${c.variants.map((v) => `<a class="btn tiny" href="/api/media/${c.id}/${v.replace(":", "x")}.mp4" download>${icon("down", 12)}${esc(v)}</a>`).join("")}</div>` : ""}</div><div>${statusBadge(c.status)}<h3 class="mt">${esc(c.headline)}</h3><p>${esc(c.copy)}</p><div class="eyebrow mt">Narration</div><p>${esc(c.voiceover)}</p><div class="eyebrow mt">Creative direction</div>${Object.entries(
      c.genome,
    )
      .filter(([k]) => k !== "angleId")
      .map(
        ([k, v]) =>
          `<span class="tag" title="${esc(human(k))}">${esc(human(v))}</span>`,
      )
      .join(
        "",
      )}</div></div><details class="form-section mt"><summary>Policy & visual review</summary>${checks(c.policy)}${c.visual ? checks([{ name: "Visual review", severity: c.visual.verdict, detail: c.visual.findings.join(" ") }]) : '<p class="muted small">Visual review is pending.</p>'}</details><details class="form-section"><summary>Technical checks · all formats</summary>${checks(c.qa)}</details><details class="form-section"><summary>Production details</summary>${btn("View all requests & costs", "usage-creative", c.id, "tiny", "money")}<p class="small muted">${esc(c.provider)} · ${esc(c.model)}</p>${c.shots.map((s, i) => `<div class="code">Shot ${i + 1} · ${esc(s.status)}\nTask: ${esc(s.taskId || "Not submitted")}</div>`).join("")}</details>`,
  );
}
function funnelDetail(id) {
  const f = state.data.funnels[id],
    p = state.plans?.options.find((p) => p.templateId === id),
    b = brandBy(state.funnelBrand);
  modal(
    f.name,
    "A closer look at the audience, budget, and role of each stage.",
    `<p class="small muted">${esc(funnelDescriptions[id])}</p><div class="table-wrap mt"><table class="funnel-details-table"><thead><tr><th>Stage</th><th>Budget</th><th>Objective</th><th>Audience</th></tr></thead><tbody>${f.stages.map((s, i) => `<tr><td><strong>${esc(s.label)}</strong></td><td>${p && b ? esc(money(p.stages[i].dailyBudgetMinor, b.currency)) : `${Math.round(s.budgetShare * 100)}%`}</td><td>${esc(human(p?.stages[i]?.arithmetic?.rung ?? s.fixedRung ?? "Brand conversion"))}</td><td>${s.target.length ? s.target.map((t) => esc(state.data.audiences[t]?.label)).join(", ") : s.suggest?.length ? `Broad · suggested: ${s.suggest.map((t) => esc(state.data.audiences[t]?.label)).join(", ")}` : "Broad · Advantage+ audience"}</td></tr>`).join("")}</tbody></table></div>${p?.refusal ? `<div class="notice warn mt">${icon("info")}<span>${esc(p.refusal)}</span></div>` : ""}${f.stages.map((s) => `<div class="mt"><h3 class="small">${esc(s.label)}</h3><p class="small muted">${esc(stageDescriptions[s.id] ?? s.purpose)}</p></div>`).join("")}<div class="form-footer">${btn("Close", "close")}${b && !p?.refusal ? btn("Use this funnel", "select-funnel", id, "primary", "check") : !b ? btn("Add a brand", "new-brand", "", "primary", "plus") : ""}</div>`,
  );
}
async function refresh(show = false) {
  const d = await api("/bootstrap");
  state.data = d;
  if(currentPage()==="engagement")state.commentsKey="";
  if(currentPage()==="usage")state.usageKey="";
  state.online = true;
  if (show) toast("Workspace updated.");
  render();
}
async function action(name, id, el) {
  if(name === "usage-detail"){usageDetail(id);return;}
  if(name === "usage-reload"){state.usageKey="";await loadUsage();return;}
  if(name === "usage-next" || name === "usage-previous"){state.usageOffset=Math.max(0,state.usageOffset+(name==="usage-next"?50:-50));render();return;}
  if(name === "usage-pricing"){await usagePricing();return;}
  if(name === "usage-clear"){state.usageFilters.run="";state.usageFilters.creative="";state.usageOffset=0;render();return;}
  if(name === "usage-run" || name === "usage-creative"){if(dialog.open)dialog.close();state.usageFilters.run=name==="usage-run"?id:"";state.usageFilters.creative=name==="usage-creative"?id:"";state.usageOffset=0;location.hash="usage";render();return;}

  if(name === "engagement-settings"){engagementSettings(id);return;}
  if(name === "engagement-subscribe"){await api(`/engagement/${id}/subscribe`,"POST",{});toast("Facebook comment notifications enabled.");return;}
  if(name === "engagement-sync"){await api(`/engagement/${id}/sync`,"POST",{});toast("Comment and destination checks queued.");return;}
  if(name === "reply-rule-add"){$("#reply-rules").insertAdjacentHTML("beforeend",replyRuleFields({},Date.now()));return;}
  if(name === "reply-rule-remove"){el.closest("[data-rule]").remove();return;}
  if(name === "comment-open"){commentDetail(id);return;}
  if(name === "comment-reload"){await loadComments();return;}
  if(name === "comment-more"){await loadComments(true);return;}
  if(name === "comment-dismiss" || name === "comment-draft"){await api(`/comments/${id}/${name === "comment-draft" ? "draft" : "dismiss"}`,"POST",{});dialog.close();await refresh();toast(name === "comment-draft" ? "A new AI draft is queued." : "Conversation closed.");return;}
  if(name === "knowledge-open"){knowledgeDetail(id);return;}
  if(name === "knowledge-refresh"){await api(`/knowledge/${id}/refresh`,"POST",{});dialog.close();toast("Page refresh queued.");return;}

  if (name === "close") {
    dialog.close();
    return;
  }
  if (name === "menu") {
    const opened = $(".shell").classList.toggle("menu-open");
    $(".sidebar").inert = !opened;
    el.setAttribute("aria-expanded", String(opened));
    if (opened) $(".nav a")?.focus();
    return;
  }
  if (name === "new-brand" || name === "edit-brand") {
    brandForm(id);
    return;
  }
  if (name === "creative-detail") {
    creativeDetail(id);
    return;
  }
  if (name === "funnel-detail") {
    funnelDetail(id);
    return;
  }
  if (name === "days") {
    state.days = Number(id);
    render();
    return;
  }
  if (name === "chart-metric") {
    state.metric = state.metric === "spendMinor" ? "conversions" : "spendMinor";
    render();
    return;
  }
  if (name === "run-filter") {
    state.runFilter = id;
    render();
    return;
  }
  if (name === "creative-filter") {
    state.creativeFilter = id;
    render();
    return;
  }
  if (name === "refresh") {
    await refresh(true);
    return;
  }
  if (name === "demo") {
    await api("/demo", "POST", {});
    await refresh();
    state.brand = "nord-demo";
    state.currency = "SEK";
    location.hash = "brands";
    render();
    toast(
      "Simulation brand added. Select Run to exercise the complete workflow.",
    );
    return;
  }
  if (name === "new-run") {
    const bs = selectedBrands();
    if (!bs.length) {
      brandForm();
      return;
    }
    modal(
      "Make the next move.",
      "Choose a brand for the next creative cycle.",
      `<div class="form-grid">${field("launch-brand", "Brand", state.brand || bs[0].id, { options: bs.map((b) => [b.id, b.name]), full: true })}</div><div class="form-error" role="alert"></div><div class="form-footer">${btn("Cancel", "close")}${btn("Continue", "continue-run", "", "primary", "arrow")}</div>`,
      true,
    );
    return;
  }
  if (name === "continue-run") {
    await action("run", $('[name="launch-brand"]', dialog).value, el);
    return;
  }
  if (name === "run") {
    const b = brandBy(id);
    if (b.mode === "STAGE" || (b.mode === "LIVE" && !b.autonomy)) {
      launchDialog(id);
      return;
    }
    await api(`/brands/${id}/run`, "POST", {});
    dialog.close();
    location.hash = "campaigns";
    await refresh();
    toast(
      b.mode === "SIMULATE"
        ? "Simulation queued. Rendering all formats may take a few minutes."
        : "Campaign queued.",
    );
    return;
  }
  if (name === "toggle-brand") {
    const b = brandBy(id);
    if (!b.autonomy) {
      launchDialog(id);
      return;
    }
    await api(`/brands/${id}/pause`, "POST", {});
    await refresh();
    toast("Brand paused.");
    return;
  }
  if (name === "confirm-enable") {
    const b = brandBy(id);
    if (b.mode === "STAGE") await api(`/brands/${id}/run`, "POST", {});
    else
      await api(`/brands/${id}/autonomy`, "POST", {
        enabled: true,
        dailyBudgetMinor: b.spend.dailyBudgetMinor,
        maxDailyBudgetMinor: b.spend.maxDailyBudgetMinor,
      });
    dialog.close();
    location.hash = "campaigns";
    await refresh();
    toast("The workflow is ready to begin.");
    return;
  }
  if (name === "pause-run") {
    await api(`/runs/${id}/pause`, "POST", {});
    await refresh();
    toast("Brand paused.");
    return;
  }
  if (name === "retry-run") {
    await api(`/runs/${id}/retry`, "POST", {});
    await refresh();
    toast("Stopped step queued for retry.");
    return;
  }
  if (name === "pause-all") {
    await api("/workspace/pause", "POST", {});
    await refresh();
    toast(
      state.data.settings.emergencyPending
        ? "Meta pause requests are being retried."
        : "Workspace paused.",
    );
    return;
  }
  if (name === "resume-all") {
    await api("/workspace/resume", "POST", {});
    await refresh();
    toast("Workspace resumed. Enable a brand when ready.");
    return;
  }
  if (name === "check-brand") {
    const r = await api(`/brands/${id}/check`, "POST", {});
    await refresh();
    modal(
      "Connection checks",
      brandBy(id).name,
      checks(r.checks) +
        `<div class="form-footer">${brandBy(id).mode !== "SIMULATE" ? btn("Inspect reporting keys", "reporting-keys", id) : ""}${btn("Done", "close", "", "primary")}</div>`,
    );
    return;
  }
  if (name === "reporting-keys") {
    const result = await api(`/brands/${id}/reporting-keys`);
    modal(
      "Choose the result you measure.",
      brandBy(id).name,
      `<p class="small muted">These action keys were returned by this account in the last 30 days. Match the key to the actual call or conversion result you track in Meta. The brand must be paused to change its mapping.</p><div class="form-error" role="alert"></div>${result.keys.length ? result.keys.map((key) => `<div class="list-row"><div class="list-text"><p>${esc(key)}</p></div>${btn("Use this key", "select-result", `${id}|${key}`, "tiny")}</div>`).join("") : '<div class="notice warn mt">No action keys were reported. Establish the intended conversion measurement in Meta before enabling live optimization.</div>'}`,
    );
    return;
  }
  if (name === "select-result") {
    const [brandId, key] = id.split("|");
    const brand = brandBy(brandId);
    await api(`/brands/${brandId}`, "PUT", { ...brand, resultActionType: key });
    dialog.close();
    await refresh();
    toast("Result reporting key saved.");
    return;
  }
  if (name === "check-connections") {
    const r = await api("/connections/check", "POST", {});
    modal(
      "Connection checks",
      "Read-only verification. No ads are created.",
      checks(r.checks),
    );
    return;
  }
  if (name === "discover") {
    const assets = await api("/assets");
    await refresh();
    assetPicker(assets);
    return;
  }
  if (name === "select-assets") {
    for (const input of $$(`input[name="${id}"]`, dialog)) if (!input.closest(".asset-choice").hidden) input.checked = true;
    return;
  }
  if (name === "facebook-connect") { await startFacebook("connect"); return; }
  if (name === "facebook-login") { await startFacebook("login"); return; }
  if (name === "brand-assets") { await loadBrandAssets(el.closest("form")); return; }
  if (name === "facebook-disconnect") {
    modal("Disconnect advertising?", "The workspace will pause its managed campaigns before removing the advertising connection.", `<p class="small muted">Facebook owner sign-in stays linked. Existing campaigns must be confirmed paused before the connection can be removed.</p><div class="form-error" role="alert"></div><div class="form-footer">${btn("Cancel","close")}${btn("Pause & disconnect","facebook-disconnect-confirm","","primary")}</div>`,true);
    return;
  }
  if (name === "facebook-disconnect-confirm") {
    await api("/meta/disconnect","POST",{}); dialog.close(); await refresh(); toast("Advertising disconnected. Your workspace is paused."); return;
  }
  if (name === "select-funnel") {
    const b = brandBy(state.funnelBrand);
    await api(`/brands/${b.id}`, "PUT", { ...b, funnel: id });
    dialog.close();
    state.plans = null;
    await refresh();
    toast("Funnel selected.");
    return;
  }
  if (name === "password") {
    const f=state.data.facebook;
    modal("Workspace access", "Facebook sign-in and owner recovery.", `<div class="access-identity"><div class="service facebook-mark">f</div><div><strong>${esc(f.owner || "Facebook sign-in is not linked")}</strong><p class="small muted">${f.linked ? "Only this linked Facebook account can open the workspace." : "Link Facebook to sign in without entering a workspace password."}</p></div></div>${f.configured ? btn(f.linked ? "Reconnect Facebook" : "Link Facebook sign-in","facebook-connect","","soft") : '<a class="btn" href="#connections" data-action="close">Set up Facebook login</a>'}<details class="form-section mt"><summary>${f.recoveryPassword ? "Change recovery password" : "Add a recovery password"}</summary><form data-form="password"><div class="form-error" role="alert"></div><div class="form-grid">${f.recoveryPassword ? field("current","Current password","",{type:"password",required:true,full:true}) : ""}${field("password","New recovery password","",{type:"password",required:true,full:true,help:"At least 12 characters. Keep this for account recovery."})}</div><div class="form-footer"><button class="btn primary">Save recovery password</button></div></form></details><div class="form-footer">${btn("Sign out","logout","","","logout")}</div>`,true);
    return;
  }
  if (name === "logout") {
    await api("/logout", "POST", {});
    dialog.close();
    state.data = null;
    await init();
  }
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const wasDisabled = el.disabled;
  el.disabled = true;
  try {
    await action(el.dataset.action, el.dataset.id ?? "", el);
  } catch (err) {
    const error = dialog.open ? $(".form-error", dialog) : null;
    if (error) {
      error.textContent = err.message;
      error.scrollIntoView({ block: "nearest" });
    } else toast(err.message, true);
  } finally {
    el.disabled = wasDisabled;
  }
});
document.addEventListener("change", (e) => {
  if(e.target.dataset.usageFilter){state.usageFilters[e.target.dataset.usageFilter]=e.target.value;state.usageOffset=0;render();}

  if(e.target.id === "comment-filter"){state.commentFilter=e.target.value;state.comments=null;render();}
  if(e.target.name === "replyProvider"){e.target.form.elements.replyModel.innerHTML=state.data.engagement.models[e.target.value].map(m=>`<option>${esc(m)}</option>`).join("");}

  if (["adAccountId","pageId"].includes(e.target.name) && e.target.form?.dataset.form === "brand") {
    const form=e.target.form;
    if (e.target.name === "adAccountId") {
      const account=state.data.metaAssets?.accounts.find(a=>a.id===e.target.value);
      if(account){form.elements.currency.value=account.currency;form.elements.timezone.value=account.timezone_name;}
      form.elements.pixelId.value="";
    } else { form.elements.leadFormId.value=""; form.elements.instagramUserId.value=""; }
    void loadBrandAssets(form);
  }
  if (e.target.id === "brand-filter") {
    state.brand = e.target.value;
    state.usageOffset=0;
    if (state.brand) state.currency = brandBy(state.brand).currency;
    state.plans = null;
    state.funnelBrand = state.brand;
    render();
  }
  if (e.target.id === "currency-filter") {
    state.currency = e.target.value;
    state.brand = "";
    render();
  }
  if (e.target.id === "funnel-brand") {
    state.funnelBrand = e.target.value;
    state.plans = null;
    render();
  }
  if (e.target.name === "archetype" && e.target.form?.dataset.form === "brand") {
    const event = e.target.form.elements.customEventType;
    if (event && ["", "PURCHASE", "LEAD"].includes(event.value)) {
      if (e.target.value === "website_lead") event.value = "LEAD";
      if (e.target.value === "website_purchase") event.value = "PURCHASE";
    }
  }
  if (e.target.name === "provider") {
    const form = e.target.form;
    form.elements.videoModel.value =
      e.target.value === "minimax" ? "MiniMax-H3" : e.target.value === "veo"
        ? "veo-3.1-generate-001"
        : "seedance-1-5-pro-251215";
  }
});
document.addEventListener("input", (e) => {
  if(e.target.name === "assetSearch") {
    const query=e.target.value.toLowerCase().trim();
    for(const row of $$(".asset-choice",dialog)) row.hidden=!row.dataset.search.includes(query);
  }
  if (
    e.target.name === "name" &&
    e.target.form?.dataset.form === "brand" &&
    !e.target.form.dataset.id
  ) {
    e.target.form.elements.id.value = e.target.value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
  }
});
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!form.matches("[data-form]")) return;
  e.preventDefault();
  const submit = e.submitter,
    error = $(".form-error", form);
  error.textContent = "";
  if (submit) submit.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    if(form.dataset.form === "engagement"){
      const rules=$$("[data-rule]",form).map(row=>({label:$("input",row).value,questions:$("textarea",row).value.split("\n").map(s=>s.trim()).filter(Boolean),reply:$$("textarea",row)[1].value})).filter(r=>r.label||r.questions.length||r.reply);
      await api(`/engagement/${form.dataset.id}`,"POST",{mode:values.engagementMode,dailyLimit:Number(values.dailyLimit),aiEnabled:form.elements.aiEnabled.checked,provider:values.replyProvider,model:values.replyModel,aiDailyLimit:Number(values.aiDailyLimit),knowledgeUrls:values.knowledgeUrls.split("\n").map(s=>s.trim()).filter(Boolean),rules});dialog.close();await refresh();toast("Engagement settings saved.");
    }
    if(form.dataset.form === "comment-reply"){await api(`/comments/${form.dataset.id}/approve`,"POST",{reply:values.reply});dialog.close();await refresh();toast("Public reply approved and queued.");}
    if (form.dataset.form === "facebook-config") {
      await api("/meta/config","POST",values); await refresh(); toast("Facebook app setup saved.");
    }
    if (form.dataset.form === "facebook-assets") {
      const selected=new FormData(form);
      await api("/meta/assets/select","POST",{accountIds:selected.getAll("accountIds"),pageIds:selected.getAll("pageIds")});
      dialog.close(); await refresh(); toast("Selected accounts and Pages saved.");
    }
    if (["facebook-setup","facebook-recover"].includes(form.dataset.form)) {
      await startFacebook(form.dataset.form === "facebook-setup" ? "setup" : "recover",{token:values.token,config:{appId:values.appId,appSecret:values.appSecret,configId:values.configId}});
    }
    if (form.dataset.form === "auth") {
      const r = await api(state.setup ? "/setup" : "/login", "POST", values);
      state.csrf = r.csrf;
      await refresh();
    }
    if (form.dataset.form === "brand") {
      const id = form.dataset.id,
        old = brandBy(id),
        v = values,
        o = offset(v.currency.toUpperCase()),
        split = (s) =>
          String(s ?? "")
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
        major = (k) => Math.round(Number(v[k]) * o);
      const b = {
        ...old,
        id: id || v.id,
        name: v.name,
        proposition: v.proposition,
        archetype: v.archetype,
        language: v.language,
        mode: v.mode,
        countries: v.countries.split(/[,\s]+/).filter(Boolean),
        currency: v.currency.toUpperCase(),
        timezone: v.timezone,
        spend: {
          dailyBudgetMinor: major("dailyBudget"),
          maxDailyBudgetMinor: major("maxBudget"),
          targetCpaMinor: major("targetCpa"),
          ...(v.targetRoas ? { targetRoas: Number(v.targetRoas) } : {}),
        },
        generationDailyUsd: Number(v.generationDailyUsd),
        lifetimeLimitMinor: major("lifetimeLimit"),
        creativesPerCycle: Number(v.creativesPerCycle),
        claims: {
          substantiated: split(v.approved),
          neverSay: split(v.neverSay),
          neverShow: split(v.neverShow),
          likenessRightsConfirmed: false,
        },
        specialAdCategories: [v.specialAdCategories],
        pageId: v.pageId,
        adAccountId: v.adAccountId,
        instagramUserId: v.instagramUserId,
        destination: Object.fromEntries(
          [
            "url",
            "pixelId",
            "customEventType",
            "leadFormId",
            "phoneNumber",
            "applicationId",
            "objectStoreUrl",
            "productSetId",
          ]
            .filter((k) => v[k])
            .map((k) => [k, v[k]]),
        ),
        privacyPolicyUrl: v.privacyPolicyUrl,
        productImage: v.productImage,
        websiteDescription: v.websiteDescription,
        funnel: v.funnel,
        assets: v.assets,
        warmPoolSize: Number(v.warmPoolSize),
        purchasesLast180d: Number(v.purchasesLast180d),
        audienceIds: Object.fromEntries(
          Object.entries(v)
            .filter(([k, val]) => k.startsWith("audience:") && val)
            .map(([k, val]) => [k.slice(9), val]),
        ),
        leadWebhookUrl: v.leadWebhookUrl,
        leadFormLocale: v.leadFormLocale,
        attributionClickDays: Number(v.attributionClickDays),
        catalogCreativeId: v.catalogCreativeId,
        resultActionType: v.resultActionType,
      };
      await api(id ? `/brands/${id}` : "/brands", id ? "PUT" : "POST", b);
      dialog.close();
      state.plans = null;
      await refresh();
      toast("Brand saved.");
    }
    if (form.dataset.form === "usage-rate") {
      const payload={key:form.dataset.key,input:Number(values.input),output:Number(values.output),cached:Number(values.cached)};
      if(form.elements.longInput)payload.longContext={input:Number(values.longInput),output:Number(values.longOutput),cached:Number(values.longCached)};
      await api("/usage/pricing","POST",payload);toast("Rate saved for future requests.");await usagePricing();
    }
    if (form.dataset.form === "connections") {
      const secretNames = [
        "metaAppId",
        "metaAppSecret",
        "metaToken",
        "minimaxKey",
        "glmKey",
        "metaWebhookVerifyToken",
        "openaiKey",
        "seedanceKey",
        "googleServiceAccount",
        "conversionWebhookToken",
        "leadWebhookSecret",
      ];
      const secrets = Object.fromEntries(
        Object.entries(values).filter(([k, v]) => secretNames.includes(k) && v),
      );
      const settings = Object.fromEntries(
        Object.entries(values)
          .filter(([k]) => !secretNames.includes(k))
          .map(([k, v]) => [
            k,
            [
              "textInputUsdPerMillion",
              "textOutputUsdPerMillion",
              "textCachedUsdPerMillion",
              "h3UsdPerSecond",
              "pollMinutes",
            ].includes(k)
              ? Number(v)
              : v,
          ]),
      );
      await api("/connections", "POST", { secrets, settings });
      await refresh();
      toast("Connection settings saved.");
    }
    if (form.dataset.form === "password") {
      const r = await api("/password", "POST", values);
      state.csrf = r.csrf;
      dialog.close();
      await refresh();
      toast("Recovery password saved. Other sessions have been signed out.");
    }
  } catch (err) {
    error.textContent = err.message;
    error.scrollIntoView({ block: "nearest" });
  } finally {
    if (submit) submit.disabled = false;
  }
});
function authPage(setup, facebook = state.facebookSession || {}) {
  state.setup = setup;
  state.facebookSession = facebook;
  const appFields = `${field("appId","Meta app ID","",{required:!facebook.configured,placeholder:facebook.configured ? "Saved · leave blank to keep" : "Your Meta app ID"})}${field("appSecret","Meta app secret","",{type:"password",required:!facebook.configured,placeholder:facebook.configured ? "Saved securely" : "Your Meta app secret"})}${field("configId","Facebook Login configuration ID","",{required:!facebook.configured,help:"Choose a User access token configuration."})}`;
  const connectForm = (recover=false) => `<form data-form="${recover ? "facebook-recover" : "facebook-setup"}"><div class="form-error" role="alert"></div>${field("token","Workspace setup token","",{required:true,type:"password",help:"Use the token on your server to verify that you own this workspace."})}${!facebook.configured ? appFields : ""}<button class="btn primary">${recover ? "Recover with Facebook" : "Continue with Facebook"}${icon("arrow",15)}</button></form>`;
  const passwordForm = `<form data-form="auth"><div class="form-error" role="alert"></div>${setup ? field("token","Workspace setup token","",{required:true,type:"password"}) : ""}${field("password",setup ? "Recovery password" : "Password","",{required:true,type:"password",help:setup ? "Use at least 12 characters." : ""})}<button class="btn ${setup ? "" : "primary"}">${setup ? "Set up with a password" : "Open workspace"}${icon("arrow",15)}</button></form>`;
  app.innerHTML = `<div class="auth-page"><aside class="auth-story"><div class="logo"><img src="/mark.svg" alt="">Spend Control</div><div class="auth-copy"><div class="eyebrow">A more considered approach</div><h1>Less noise.<br>More direction.</h1><p>A quiet workspace for advertising that learns, adapts, and moves your business forward.</p><div class="auth-art" aria-hidden="true"><div class="auth-block"></div><div class="auth-block b"><div class="abstract-line"></div><div class="abstract-line short"></div></div><div class="auth-block c"></div></div></div><p class="auth-story-foot">Designed for clarity. Built for the everyday.</p></aside><main class="auth-form-wrap" id="main"><div class="auth-form"><div class="eyebrow">Your workspace awaits</div><h2 class="mt">${setup ? "One connection.<br>A clearer view." : "Welcome back."}</h2><p>${setup ? "Connect Facebook to bring your advertising accounts and Pages into one workspace." : "Sign in to your advertising workspace."}</p>${state.facebookError ? `<div class="notice warn"><span>${esc(state.facebookError)}</span></div>` : ""}${setup ? connectForm() + `<details class="auth-alternative"><summary>Use a workspace password instead</summary>${passwordForm}</details>` : facebook.configured && facebook.linked ? `<button class="btn primary facebook-login" data-action="facebook-login"><span class="facebook-mark">f</span>Continue with Facebook${icon("arrow",15)}</button>${facebook.recoveryPassword ? `<details class="auth-alternative"><summary>Use recovery password</summary>${passwordForm}</details>` : ""}` : facebook.recoveryPassword ? passwordForm : `<p class="small muted">Facebook access was removed. Verify workspace ownership to reconnect.</p>${connectForm(true)}`}${!setup && (facebook.linked || facebook.recoveryPassword) ? `<details class="auth-alternative"><summary>Recover owner access</summary>${connectForm(true)}</details>` : ""}<p class="auth-help">${icon("shield",13)} Your Facebook password is entered only on Facebook.</p><div class="auth-links"><a href="/privacy">Privacy</a><a href="/data-deletion">Data removal</a><a href="/meta-setup">Setup guide</a></div></div></main></div>`;
}
async function init() {
  try {
    const s = await api("/session");
    state.csrf = s.csrf;
    state.facebookSession = s.facebook;
    const query = new URLSearchParams(location.search);
    state.facebookError = query.get("facebook") === "error" ? query.get("message") || "Facebook connection could not be completed." : "";
    const justConnected = query.get("facebook") === "connected";
    if (query.has("facebook")) history.replaceState(null,"",location.pathname + location.hash);
    if (s.authenticated) await refresh();
    else authPage(s.setupRequired, s.facebook);
    if (s.authenticated && justConnected) {
      toast("Facebook connected. Choose the assets this workspace should manage.");
      try { const assets=await api("/assets"); await refresh(); assetPicker(assets); }
      catch(error) { toast(error.message,true); }
    }
  } catch (e) {
    app.innerHTML = `<main class="screen-error"><h1>We couldn’t open the workspace.</h1><p class="muted mt">${esc(e.message)}</p><button class="btn primary mt" data-action="refresh">Try again</button></main>`;
  }
}
window.addEventListener("hashchange", () => {
  if (state.data) {
    render();
    $("#main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
});
dialog.addEventListener("close", () => {
  $$("video", dialog).forEach((v) => v.pause());
});
function $$(s, r = document) {
  return [...r.querySelectorAll(s)];
}
setInterval(async () => {
  if (
    !state.data ||
    document.hidden ||
    dialog.open ||
    currentPage() === "connections" ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)
  )
    return;
  try {
    const scroll = window.scrollY;
    await refresh();
    window.scrollTo(0, scroll);
  } catch {
    state.online = false;
    render();
  }
}, 15000);
window.addEventListener("resize", () => {
  if (!state.data) return;
  $(".sidebar").inert =
    window.innerWidth <= 760 && !$(".shell").classList.contains("menu-open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $(".shell")?.classList.contains("menu-open")) {
    $(".shell").classList.remove("menu-open");
    $(".sidebar").inert = true;
    $(".mobile-menu").setAttribute("aria-expanded", "false");
    $(".mobile-menu").focus();
  }
});
void init();

function engagementSettings(id) {
  const b=brandBy(id), c=state.data.engagement.configs.find(c=>c.id===id) || {mode:"off",dailyLimit:50,aiEnabled:true,provider:"glm",model:"glm-5.2",aiDailyLimit:100,knowledgeUrls:[],rules:[]};
  modal(`${b.name} · Engagement`,"Give every conversation the right context and next step.",`<form data-form="engagement" data-id="${esc(id)}"><div class="form-error" role="alert"></div><section class="form-section"><div class="form-grid">${field("engagementMode","Reply mode",c.mode,{options:[["off","Off"],["review","Collect comments & draft for review"],["auto","Publish approved and verified AI replies"]],full:true})}${field("dailyLimit","Public replies per day",c.dailyLimit,{type:"number",min:1,step:"1",help:"A separate limit from advertising spend."})}${field("aiDailyLimit","AI requests per day",c.aiDailyLimit,{type:"number",min:1,step:"1",help:"Page profiles and reply checks share this allowance."})}</div><p class="small muted mt">Automatic publishing requires a live brand. Older comments remain in review when you turn it on. Pause all stops public replies.</p></section><section class="form-section"><h3>Page intelligence</h3><label class="toggle-line"><input type="checkbox" name="aiEnabled" ${c.aiEnabled ? "checked" : ""}> Read ad destinations and draft contextual replies</label><div class="form-grid">${field("replyProvider","Reply provider",c.provider,{options:[["glm","Z.AI · GLM"],["minimax","MiniMax"]]})}${field("replyModel","Reply model",c.model,{options:state.data.engagement.models[c.provider]})}${field("knowledgeUrls","Additional knowledge pages",c.knowledgeUrls.join("\n"),{area:true,full:true,rows:3,placeholder:"https://your-brand.com/faq",help:"One public HTTPS URL per line. Ad destination pages are discovered automatically. Add useful FAQ, delivery, or product pages."})}</div><p class="small muted">Drafts use the relevant landing page, ad copy, and approved facts. Questions that lack a supported answer enter review. People are invited to message or complete the form according to the ad.</p></section><section class="form-section"><h3>Approved answers</h3><p class="small muted">Optional shortcuts and brand knowledge. Exact example questions can use these replies directly.</p><div id="reply-rules">${c.rules.map((r,i)=>replyRuleFields(r,i)).join("")}</div>${btn("Add approved answer","reply-rule-add","","tiny","plus")}</section><div class="form-footer">${c.mode!=="off" ? btn("Enable Facebook notifications","engagement-subscribe",id,"tiny") : ""}${btn("Cancel","close")}<button class="btn primary">Save engagement settings</button></div></form>`);
}
function replyRuleFields(r={},i=0){return `<div class="reply-rule" data-rule><div class="form-grid">${field(`ruleLabel${i}`,"Answer label",r.label||"",{full:true,placeholder:"Product care"})}${field(`ruleQuestions${i}`,"Example questions",(r.questions||[]).join("\n"),{area:true,full:true,help:"One complete question per line."})}${field(`ruleReply${i}`,"Approved reply",r.reply||"",{area:true,full:true})}</div><button type="button" class="btn tiny" data-action="reply-rule-remove">Remove answer</button></div>`;}
async function loadComments(more=false) {
  const queryKey=`${state.brand}:${state.commentFilter||"attention"}`;
  if(state.commentsLoading)return;
  state.commentsLoading=true;const request=++state.commentRequest;
  try{
    const result=await api(`/engagement/comments?brand=${encodeURIComponent(state.brand)}&status=${encodeURIComponent(state.commentFilter||"attention")}&offset=${more ? state.comments?.nextOffset||0 : 0}`);
    if(request!==state.commentRequest || queryKey!==`${state.brand}:${state.commentFilter||"attention"}`)return;
    state.commentsError="";state.comments=more ? {...result,items:[...state.comments.items,...result.items]} : result;state.commentsKey=queryKey;
  }catch(error){state.commentsError=error.message;state.commentsKey=queryKey;state.comments={items:[],total:0,nextOffset:null};}
  finally{state.commentsLoading=false;if(currentPage()==="engagement")render();}
}
function engagement() {
  const data=state.data.engagement, count=data.counts, threads=data.threads.filter(t=>!state.brand||t.brandId===state.brand), brands=state.data.brands.filter(b=>!state.brand||b.id===state.brand);
  const attention=(count.review||0)+(count.failed||0)+(count.uncertain||0), replies=(count.replied||0)+(count.answered||0), stale=threads.filter(t=>t.error||!t.lastSyncedAt||Date.parse(t.lastSyncedAt)<Date.now()-15*60000);
  const queryKey=`${state.brand}:${state.commentFilter||"attention"}`;
  if((!state.comments || state.commentsKey!==queryKey)&&!state.commentsLoading)void loadComments();
  const rows=state.comments?.items||[];
  return heading("A conversation, kept going.","Helpful answers with the context of each ad and its landing page.",'<a class="btn" href="#intelligence">Page intelligence '+icon("arrow",15)+'</a>',"Engagement")+
  `<section class="stats">${stat("Needs your attention",num(attention),"Questions, support and uncertain deliveries","info")}${stat("Answered",num(replies),"Confirmed replies and existing Page responses","check")}${stat("Waiting to send",num((count.queued||0)+(count.sending||0)),"Checked against current access and daily limits","clock")}${stat("Ad conversations",num(threads.length),stale.length ? `${stale.length} coverage checks need attention` : "Facebook and Instagram ad posts","campaigns")}</section>`+
  (stale.length ? `<div class="notice warn">${icon("info")}<span>Some posts have not been checked recently or need access. Review coverage below; the inbox may be incomplete.</span></div>`:"")+
  `<section class="panel"><div class="panel-head"><div><h2>Each brand, its own approach</h2><p>Enable collection, choose a model, and set a reply allowance.</p></div></div>${brands.length ? brands.map(b=>{const c=data.configs.find(c=>c.id===b.id),usage=data.usage.find(u=>u.brandId===b.id);return `<div class="engagement-brand"><div class="brand-dot">${esc(b.name.slice(0,1))}</div><div class="engagement-brand-title"><strong>${esc(b.name)}</strong><p class="small muted">${c?.aiEnabled ? esc(c.model) : "Approved answers"} · ${usage?.requests||0} AI requests today${c?.lastDiscoveryAt ? ` · Checked ${ago(c.lastDiscoveryAt)}` : ""}</p>${c?.error ? `<p class="small error-text">${esc(c.error)}</p>`:""}</div>${badge(c?.mode==="auto" ? "Automatic replies" : c?.mode==="review" ? "Review mode" : "Off",c?.mode==="auto"?"green":"")}${btn("Settings","engagement-settings",b.id,"tiny","edit")}${c?.mode&&c.mode!=="off" ? btn("Sync comments","engagement-sync",b.id,"tiny","refresh") : ""}</div>`;}).join(""):empty("Add a brand to start.","Connect its ad account and Page, then choose how to respond.",btn("Add brand","new-brand","","primary","plus"))}</section>`+
  `${state.commentsError ? `<div class="notice error">${esc(state.commentsError)} ${btn("Try again","comment-reload","","tiny")}</div>` : ""}<section class="panel mt"><div class="panel-head"><div><h2>Your comment inbox</h2><p>${state.commentsLoading ? "Loading conversations…" : `${state.comments?.total||0} comments in this view`}</p></div><select id="comment-filter" aria-label="Comment status">${[["attention","Needs attention"],["all","All comments"],["queued","Waiting to send"],["replied","Replied automatically / approved"],["answered","Already answered"],["ignored","Closed & own replies"]].map(([id,label])=>`<option value="${id}" ${(state.commentFilter||"attention")===id?"selected":""}>${label}</option>`).join("")}</select></div>${rows.length ? rows.map(c=>{const t=data.threads.find(t=>t.id===c.threadId),overdue=["review","failed","uncertain"].includes(c.status)&&Date.parse(c.receivedAt)<Date.now()-3600000;return `<article class="comment-row"><div class="comment-platform">${c.platform==="facebook" ? "f" : "◎"}</div><div class="comment-body"><div class="comment-meta"><strong>${esc(c.author||"Commenter")}</strong><span>${esc(t?.adName||"Ad conversation")} · ${ago(c.createdAt||c.receivedAt)}</span>${overdue?badge("Over 1 hour","amber"):""}</div><p class="comment-text">${esc(c.text||"Attachment / empty comment")}</p>${c.reply ? `<div class="comment-preview"><span>${c.status==="replied"?"Reply":"Draft"}</span>${esc(c.reply)}</div>`:""}<p class="small muted">${esc(c.reason)}</p></div><div class="comment-status">${badge(human(c.status),["replied","answered"].includes(c.status)?"green":["review","failed","uncertain"].includes(c.status)?"amber":"")}${btn("Open","comment-open",c.id,"tiny","arrow")}</div></article>`;}).join(""):empty(state.commentsLoading?"Loading your inbox…":"You’re up to date.","New comments appear here after the worker checks connected ad posts.","","check")}${state.comments?.nextOffset!==null&&state.comments?.nextOffset!==undefined ? `<div class="panel-foot">${btn("Load more comments","comment-more","","","down")}</div>`:""}</section>`+
  `<details class="panel coverage-panel mt"><summary>Comment coverage · ${threads.length} ad posts</summary><div class="table-wrap"><table><thead><tr><th>Ad / placement</th><th>Last successful check</th><th>Status</th></tr></thead><tbody>${threads.map(t=>`<tr><td><strong>${esc(t.adName)}</strong><div class="small muted">${human(t.platform)} · ${t.adIds.length} ads</div></td><td>${t.lastSyncedAt?ago(t.lastSyncedAt):"Not checked yet"}</td><td>${esc(t.error||"Ready for the next check")}</td></tr>`).join("")}</tbody></table></div><p class="small muted">Webhooks speed up checks. Periodic scans recover missed notifications. Permissions, inaccessible posts and API limits can reduce coverage; unresolved items stay visible.</p></details>`;
}
function intelligence() {
  const d=state.data.engagement, pages=d.pages.filter(p=>!state.brand||p.brandId===state.brand), healthy=pages.filter(p=>p.fetchedAt&&!p.error), profiles=pages.filter(p=>p.profiledAt), threads=d.threads.filter(t=>!state.brand||t.brandId===state.brand);
  return heading("Every destination, understood.","A separate source of context for the offer, questions, and next step behind each ad.",'<a class="btn" href="#engagement">'+icon("arrow",15)+' Comment inbox</a>',"Page intelligence")+
  `<section class="stats">${stat("Destination pages",num(pages.length),"Discovered from your ads and source settings","external")}${stat("Pages read",num(healthy.length),"Public page content is refreshed daily","eye")}${stat("Knowledge profiles",num(profiles.length),"Model summaries with source excerpts","spark")}${stat("Ad posts connected",num(threads.length),"Context stays with the relevant conversation","campaigns")}</section>`+
  `<div class="notice">${icon("info")}<span>The worker reads public page text, then creates a profile. Replies cite that page internally and use the ad’s message or enquiry goal. Unreadable or stale sources send questions to review.</span></div>`+
  `<div class="knowledge-grid">${pages.length ? pages.map(p=>`<article class="panel knowledge-card"><div class="knowledge-head"><div class="source-icon">${icon("external",22)}</div>${badge(p.error?"Needs attention":p.profiledAt?"Knowledge ready":"Reading page",p.error?"amber":p.profiledAt?"green":"")}</div><div class="eyebrow">${esc(brandBy(p.brandId)?.name||"Brand")}</div><h2>${esc(p.title)}</h2><a class="small break-url" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a><div class="knowledge-facts">${p.profile.slice(0,3).map(f=>`<div><strong>${esc(f.label)}</strong><p>${esc(f.value)}</p></div>`).join("")||'<p class="small muted">The offer and useful details will appear after this page is read.</p>'}</div>${p.error?`<p class="small error-text">${esc(p.error)}</p>`:""}<div class="knowledge-foot"><span class="small muted">${p.fetchedAt?`Read ${ago(p.fetchedAt)}`:"Waiting for worker"}${p.model?` · ${esc(p.model)}`:""}</span>${btn("View profile","knowledge-open",p.id,"tiny","arrow")}</div></article>`).join(""):empty("Build knowledge from your ads.","Turn on page intelligence in a brand’s engagement settings. Each discovered destination will be read automatically.",'<a class="btn primary" href="#engagement">Set up engagement</a>',"spark")}</div>`;
}
function commentDetail(id) {
  const c=state.comments?.items.find(c=>c.id===id);if(!c)return;
  const t=state.data.engagement.threads.find(t=>t.id===c.threadId), editable=["review","failed"].includes(c.status), link=t?.platform==="facebook" ? `https://www.facebook.com/${t.remoteId}` : t?.permalinkUrl || "https://business.facebook.com/latest/inbox/all";
  modal("Conversation details",`${brandBy(c.brandId)?.name||"Brand"} · ${t?.adName||human(c.platform)}`,`<div class="comment-detail-original"><div class="comment-meta"><strong>${esc(c.author)}</strong>${badge(human(c.status))}</div><p>${esc(c.text)}</p><p class="small muted">${esc(c.reason)}</p></div>${c.ai?`<details class="form-section"><summary>${esc(c.ai.model)} · Evidence behind the draft</summary>${c.ai.evidence.map(e=>{const source=state.data.engagement.pages.find(p=>p.id===e.sourceId);return `<blockquote><p>${esc(e.quote)}</p><cite>${esc(source?.title||human(e.sourceId))}</cite></blockquote>`;}).join("")}</details>`:""}${editable ? `<form data-form="comment-reply" data-id="${esc(id)}"><div class="form-error" role="alert"></div>${field("reply","Public reply",c.reply,{area:true,full:true,rows:5,required:true,help:"This reply is posted publicly from your Page or Instagram account when the worker processes it."})}<div class="form-footer">${btn("Draft with AI","comment-draft",id,"","spark")}<button class="btn primary">Approve & queue public reply</button></div></form>` : c.reply?`<div class="comment-preview"><span>Reply</span>${esc(c.reply)}</div>`:""}<div class="form-footer">${link?`<a class="btn tiny" href="${link}" target="_blank" rel="noopener noreferrer">Open ${human(c.platform)} ${icon("external",13)}</a>`:""}${!["sending","replied","answered","ignored","deleted"].includes(c.status)?btn("Close without a reply","comment-dismiss",id,"tiny"):""}${btn("Done","close")}</div>`,true);
}
function knowledgeDetail(id){const p=state.data.engagement.pages.find(p=>p.id===id);if(!p)return;modal(p.title,"The page content used to support relevant replies.",`<p class="small"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a></p>${p.error?`<div class="notice warn mt">${esc(p.error)}</div>`:""}${p.profile.map(f=>`<section class="form-section"><h3>${esc(f.label)}</h3><p>${esc(f.value)}</p><blockquote>${esc(f.quote)}</blockquote></section>`).join("")}<p class="small muted mt">Profile generated by ${esc(p.model||"the selected reply model")}. Source excerpts are kept for checking the model’s interpretation.</p><div class="form-footer">${btn("Refresh this page","knowledge-refresh",id,"","refresh")}${btn("Close","close")}</div>`);}
function engagementConnections(){return `<form class="panel connection" data-form="connections"><div class="connection-title"><div class="service">${icon("spark",22)}</div><h3>Engagement intelligence</h3>${badge("MiniMax / GLM")}</div><p>Read landing pages and write contextual comment replies. Choose a model and request allowance for each brand in Engagement.</p><div class="form-error" role="alert"></div><div class="form-grid">${secret("glmKey","Z.AI API key","For GLM-5.2 through Z.AI’s standard API.")}${secret("minimaxKey","MiniMax API key","For MiniMax M2.7 or M3 through the MiniMax API.")}${secret("metaWebhookVerifyToken","Meta webhook verification token","Choose a long random secret and use the same value in your Meta app webhook setup.")}</div><div class="eyebrow mt">Comment webhook callback</div><div class="code break-url">${esc(state.data.facebook.webhookUrl||"Set APP_ORIGIN first")}</div><p class="small muted mt">Configure Page feed and Instagram comments notifications in Meta. The inbox also performs periodic checks.</p><div class="form-footer"><button class="btn primary">Save engagement connections</button></div></form>`;}
function ago(value){const delta=Math.max(0,Date.now()-Date.parse(value));if(!Number.isFinite(delta))return "Unknown";if(delta<60000)return "just now";if(delta<3600000)return `${Math.floor(delta/60000)}m ago`;if(delta<86400000)return `${Math.floor(delta/3600000)}h ago`;return `${Math.floor(delta/86400000)}d ago`;}
