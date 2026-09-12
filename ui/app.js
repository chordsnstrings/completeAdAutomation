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
  ["learning", "Decisions & activity"],
  ["connections", "Connections"],
];
const currentPage = () =>
  nav.some((n) => n[0] === location.hash.slice(1))
    ? location.hash.slice(1)
    : "overview";
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
}
const heading = (title, description, actions = "", eyebrow = "") =>
  `<header class="page-heading"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="heading-actions">${actions}</div></header>`;
const empty = (title, description, actions = "", glyph = "spark") =>
  `<div class="empty"><div class="empty-icon">${icon(glyph, 24)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>`;
const checks = (items) =>
  `<div class="checks">${items.map((c) => `<div class="check">${statusBadge(c.severity)}<div><strong>${esc(c.name)}</strong><p>${esc(c.detail)}</p>${c.remedy ? `<p>${esc(c.remedy)}</p>` : ""}</div></div>`).join("")}</div>`;
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
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="logo" href="#overview"><img src="/mark.svg" alt="">Spend Control</a><div class="workspace"><div class="workspace-icon">${icon("brands", 15)}</div><div><strong>Your workspace</strong><span>Meta advertising</span></div></div><div class="eyebrow nav-label">Workspace</div><nav class="nav" aria-label="Main navigation">${nav.map(([id, label]) => `<a href="#${id}" class="${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""}>${icon(id)}${label}${id === "campaigns" && d.runs.filter((r) => r.status === "blocked").length ? `<span class="count">${d.runs.filter((r) => r.status === "blocked").length}</span>` : ""}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="sync-status"><span class="dot ${paused || !state.online || !d.worker.enabled ? "paused" : ""}"></span>${!state.online ? "Connection interrupted" : paused ? "Workspace paused" : d.worker.enabled ? "Worker connected" : "Worker stopped"}</div><div class="account"><div class="avatar">SC</div><div><strong class="small">Workspace owner</strong><p class="muted small">Administrator</p></div><button class="icon-btn" data-action="password" aria-label="Account settings">${icon("key", 16)}</button></div></div></aside><div class="main-wrap"><div class="topbar"><div class="breadcrumb"><button class="icon-btn mobile-menu" data-action="menu" aria-label="Toggle navigation" aria-expanded="false">${icon("menu")}</button><span>Workspace</span><span>/</span><strong>${nav.find((n) => n[0] === page)[1]}</strong></div><div class="top-actions"><select aria-label="Filter by brand" id="brand-filter"><option value="">All brands</option>${d.brands.map((b) => `<option value="${esc(b.id)}" ${state.brand === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select><span class="divider"></span><button class="icon-btn" data-action="refresh" aria-label="Refresh workspace">${icon("refresh", 16)}</button>${btn(paused ? "Resume workspace" : "Pause all", paused ? "resume-all" : "pause-all", "", paused ? "soft" : "", "" + (paused ? "play" : "pause"))}</div></div><main id="main" tabindex="-1">${paused ? `<div class="notice warn">${icon("pause")}<span>${d.settings.emergencyPending ? "Pause requests are still being retried with Meta. Delivery may continue until Meta confirms them." : "The workspace is paused. Resume it and enable a brand to continue autonomous work."}</span></div>` : ""}${!state.online ? `<div class="notice error">${icon("info")}Connection interrupted. Showing the last received data.</div>` : ""}${{ overview, brands, campaigns, funnels, creatives, learning, connections }[page]()}<footer class="footer-note"><span>${icon("shield", 12)} Yours to direct. Built to work quietly.</span><span>Spend Control · Meta workspace</span></footer></main></div></div>`;
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
            return `<article class="panel run-card"><div class="run-top"><div class="run-title">${symbol(b)}<div><h3>${esc(b?.name ?? r.brandId)} <span class="muted small">/ ${esc(r.id.slice(0, 8))}</span></h3><p>${esc(r.plan?.template?.name ?? "Planning campaign")} · ${time(r.createdAt)} · ${r.creativeIds.length} creatives</p></div></div><div>${modeBadge(r.mode)} ${statusBadge(r.status)}</div></div><div class="pipeline" aria-label="Campaign progress">${phaseLabels.map((label, i) => `<div class="pipeline-step ${i < index ? "done" : i === index ? (r.status === "blocked" ? "failed" : "current") : ""}"><div class="track"></div><span>${label}</span></div>`).join("")}</div>${r.error ? `<div class="notice error">${icon("info")}<span>${esc(r.error)}</span></div>` : ""}<div class="run-bottom"><span>${r.mode === "SIMULATE" ? "No real spend" : `Video production estimate: $${r.generationCostUsd.toFixed(2)}`} · ${r.stages.length} ${r.stages.length === 1 ? "stage" : "stages"} ${r.nextAt ? `· Next step ${time(r.nextAt)}` : ""}</span><div class="heading-actions">${r.status === "blocked" ? btn("Retry step", "retry-run", r.id, "tiny soft", "refresh") : ""}${r.status !== "cancelled" ? btn("Pause brand", "pause-run", r.id, "tiny", "pause") : ""}</div></div>${r.stages.length || r.warnings.length ? `<details class="run-detail" data-run-detail="${esc(r.id)}"><summary>Campaign details & checks</summary>${r.warnings.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}${r.stages.map((s) => `<p>${esc(human(s.stageId))} · ${esc(money(s.dailyBudgetMinor, b.currency))}/day · ${s.active ? "Active" : "Paused"} · ${esc(human(s.primaryAction.replace(/^offsite_conversion\.(fb_pixel_)?/, "").replace(/^onsite_conversion\./, "")))}</p>`).join("")}</details>` : ""}</article>`;
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
    `<div class="connection-grid"><form class="panel connection" data-form="connections"><div class="connection-title"><div class="service">∞</div><h3>Meta</h3>${badge(c.metaToken ? "Credentials saved" : "Not connected", c.metaToken ? "green" : "")}</div><p>Use a system user assigned to your ad account, Facebook Page, and pixel. Set an account spending limit in Meta before enabling live delivery.</p><div class="form-error" role="alert"></div><div class="form-grid">${secret("metaAppId", "App ID")}${secret("metaAppSecret", "App secret")}${secret("metaToken", "System user access token")}</div><div class="form-footer">${btn("Discover assets", "discover", "", "tiny", "eye")}<button class="btn primary">Save Meta connection</button></div><div class="secret-note">${icon("shield", 12)} Credentials stay on the server, encrypted at rest.</div></form><form class="panel connection" data-form="connections"><div class="connection-title"><div class="service">${icon("spark", 22)}</div><h3>OpenAI</h3>${badge(c.openaiKey ? "Credentials saved" : "Not connected", c.openaiKey ? "green" : "")}</div><p>Writes grounded scripts, produces narration, and reviews the rendered films against the brand brief.</p><div class="form-error" role="alert"></div><div class="form-grid">${secret("openaiKey", "API key")}${field("textModel", "Text & vision model", s.textModel, { full: true, required: true })}${field("textInputUsdPerMillion", "Input price / 1M tokens (USD)", s.textInputUsdPerMillion, { type: "number", min: 0.01, step: ".01" })}${field("textOutputUsdPerMillion", "Output price / 1M tokens (USD)", s.textOutputUsdPerMillion, { type: "number", min: 0.01, step: ".01" })}</div><div class="form-footer"><button class="btn primary">Save OpenAI connection</button></div><div class="secret-note">${icon("info", 12)} Keep model rates current for production cost reservations.</div></form><form class="panel connection" data-form="connections"><div class="connection-title"><div class="service">${icon("creatives", 21)}</div><h3>Video generation</h3>${badge(c[s.provider === "seedance" ? "seedanceKey" : "googleServiceAccount"] ? "Credentials saved" : "Not connected", c[s.provider === "seedance" ? "seedanceKey" : "googleServiceAccount"] ? "green" : "")}</div><p>Choose Seedance or Google Veo. Production is limited by each brand’s daily USD allowance.</p><div class="form-error" role="alert"></div><div class="form-grid">${field(
      "provider",
      "Provider",
      s.provider,
      {
        options: [
          ["seedance", "Seedance · BytePlus"],
          ["veo", "Veo · Google Cloud"],
        ],
        full: true,
      },
    )}${field("videoModel", "Video model ID", s.videoModel, { full: true, required: true })}${secret("seedanceKey", "Seedance API key")}${field("googleServiceAccount", "Google service account JSON", "", { area: true, full: true, placeholder: c.googleServiceAccount ? "Connected · leave blank to keep" : "Paste the service account JSON securely" })}${field("googleProject", "Google Cloud project", s.googleProject)}${field("googleRegion", "Region", s.googleRegion)}${field("googleBucket", "Output bucket URI", s.googleBucket, { full: true, placeholder: "gs://your-bucket/generated/" })}</div><div class="form-footer"><button class="btn primary">Save video provider</button></div></form><form class="panel connection" data-form="connections"><div class="connection-title"><div class="service">${icon("connections", 21)}</div><h3>Feedback & delivery</h3>${badge("Optional")}</div><p>Send consented website conversions back to Meta and deliver incoming form leads to your CRM.</p><div class="form-error" role="alert"></div><div class="form-grid">${secret("conversionWebhookToken", "Conversion webhook bearer token", "Choose a long random secret and use it in your website’s server integration.")}${secret("leadWebhookSecret", "CRM webhook signing secret", "The receiver verifies X-Signature-SHA256 over timestamp.body and deduplicates X-Event-ID.")}${field("pollMinutes", "Reporting interval (minutes)", s.pollMinutes, { type: "number", min: 15, step: "1", full: true })}</div><div class="code">POST /api/webhooks/conversions</div><div class="form-footer"><a class="btn tiny" href="/api/export?kind=leads">${icon("down", 13)}Export ${d.leadCount} leads</a><button class="btn primary">Save feedback settings</button></div></form></div>`
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
    )}${field("countries", "Countries", v.countries?.join(", ") ?? "US", { required: true, help: "Two-letter codes separated by commas." })}</div></section><section class="form-section"><h3>02 / Boundaries & budget</h3><div class="form-grid">${field("currency", "Account currency", curr, { required: true, help: "Use the currency of the connected ad account." })}${field("timezone", "Account timezone", v.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, { required: true })}${field("dailyBudget", "Daily advertising budget", sp.dailyBudgetMinor / o || 100, { required: true, type: "number", min: 0.01, step: ".01" })}${field("maxBudget", "Maximum combined daily budget", sp.maxDailyBudgetMinor / o || 200, { required: true, type: "number", min: 0.01, step: ".01", help: "Limits the configured budgets across managed campaigns. Meta can spend more than a daily budget on an individual day." })}${field("targetCpa", "Target cost per result", sp.targetCpaMinor / o || 20, { required: true, type: "number", min: 0.01, step: ".01" })}${field("generationDailyUsd", "Daily production allowance (USD)", v.generationDailyUsd ?? 15, { required: true, type: "number", min: 0.1, step: ".1" })}${field("lifetimeLimit", "Stop at reported total spend", v.lifetimeLimitMinor / o || 0, { type: "number", min: 0, step: ".01", help: "0 disables this observed-spend stop. Reporting delay can cause overshoot; the Meta account cap is the hard backstop." })}${field("creativesPerCycle", "Creatives per funnel stage", v.creativesPerCycle ?? 3, { options: [1, 2, 3, 4, 5, 6] })}${field("approved", "Approved claims", (claims.substantiated ?? []).join("\n"), { area: true, full: true, required: true, help: "One factual, substantiated claim per line. The creative writer stays within these claims." })}${field("neverSay", "Never say", (claims.neverSay ?? []).join("\n"), { area: true })}${field("neverShow", "Never show", (claims.neverShow ?? []).join("\n"), { area: true })}${field("specialAdCategories", "Special ad category", v.specialAdCategories?.[0] ?? "NONE", { options: ["NONE", "HOUSING", "EMPLOYMENT", "CREDIT", "FINANCIAL_PRODUCTS_SERVICES", "ISSUES_ELECTIONS_POLITICS", "ONLINE_GAMBLING_AND_GAMING"], full: true })}</div></section><section class="form-section"><h3>03 / Where people go</h3><div class="form-grid">${field("url", "Website / destination URL", dest.url, { type: "url", full: true, placeholder: "https://your-brand.com/product" })}${field("pageId", "Facebook Page ID", v.pageId, { help: "Optional in simulation." })}${field("adAccountId", "Ad account ID", v.adAccountId, { placeholder: "act_123456789" })}${field("instagramUserId", "Instagram account ID", v.instagramUserId)}${field("pixelId", "Pixel / dataset ID", dest.pixelId)}${field("customEventType", "Conversion event", dest.customEventType ?? "PURCHASE", { options: ["PURCHASE", "LEAD", "COMPLETE_REGISTRATION", "CONTACT", "SUBSCRIBE", "ADD_TO_CART", "VIEW_CONTENT"] })}${field("leadFormId", "Existing lead form ID", dest.leadFormId)}${field("privacyPolicyUrl", "Privacy policy URL", v.privacyPolicyUrl, { type: "url", full: true, help: "Required to create a new Meta lead form automatically." })}${field("productImage", "Product reference image URL", v.productImage, { type: "url", full: true, help: "A public HTTPS image of your actual product." })}${field("websiteDescription", "Destination context", v.websiteDescription, { area: true, full: true, help: "Describe what visitors will find after clicking the ad." })}</div></section><details class="form-section"><summary>04 / Funnel & audience history</summary><div class="form-grid">${field("funnel", "Funnel strategy", v.funnel ?? "auto", { full: true, options: [["auto", "Recommend for my brand"], ...Object.values(state.data.funnels).map((f) => [f.id, f.name])] })}${field(
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
      )}</div></div><details class="form-section mt"><summary>Policy & visual review</summary>${checks(c.policy)}${c.visual ? checks([{ name: "Visual review", severity: c.visual.verdict, detail: c.visual.findings.join(" ") }]) : '<p class="muted small">Visual review is pending.</p>'}</details><details class="form-section"><summary>Technical checks · all formats</summary>${checks(c.qa)}</details><details class="form-section"><summary>Production details</summary><p class="small muted">${esc(c.provider)} · ${esc(c.model)}</p>${c.shots.map((s, i) => `<div class="code">Shot ${i + 1} · ${esc(s.status)}\nTask: ${esc(s.taskId || "Not submitted")}</div>`).join("")}</details>`,
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
  state.online = true;
  if (show) toast("Workspace updated.");
  render();
}
async function action(name, id, el) {
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
    const r = await api("/assets");
    modal(
      "Your Meta assets",
      "Use these IDs when configuring each brand.",
      `<h3>Ad accounts</h3>${r.accounts.length ? r.accounts.map((a) => `<div class="list-row"><div class="list-text"><strong>${esc(a.name)}</strong><p>${esc(a.id)} · ${esc(a.currency)} · ${esc(a.timezone_name)}</p></div></div>`).join("") : '<p class="muted small">No ad accounts are assigned to this system user.</p>'}<h3 class="mt">Facebook Pages</h3>${r.pages.map((p) => `<div class="list-row"><div class="list-text"><strong>${esc(p.name)}</strong><p>Page: ${esc(p.id)}${p.instagram_business_account ? ` · Instagram: ${esc(p.instagram_business_account.id)}` : ""}</p></div></div>`).join("")}`,
    );
    return;
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
    modal(
      "Workspace access",
      "Change your password or sign out of this device.",
      `<form data-form="password"><div class="form-error" role="alert"></div><div class="form-grid">${field("current", "Current password", "", { type: "password", required: true, full: true })}${field("password", "New password", "", { type: "password", required: true, full: true, help: "At least 12 characters." })}</div><div class="form-footer">${btn("Sign out", "logout", "", "", "logout")}<button class="btn primary">Update password</button></div></form>`,
      true,
    );
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
  if (e.target.id === "brand-filter") {
    state.brand = e.target.value;
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
      e.target.value === "veo"
        ? "veo-3.1-generate-001"
        : "seedance-1-5-pro-251215";
  }
});
document.addEventListener("input", (e) => {
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
    if (form.dataset.form === "connections") {
      const secretNames = [
        "metaAppId",
        "metaAppSecret",
        "metaToken",
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
      toast("Password updated. Other sessions have been signed out.");
    }
  } catch (err) {
    error.textContent = err.message;
    error.scrollIntoView({ block: "nearest" });
  } finally {
    if (submit) submit.disabled = false;
  }
});
function authPage(setup) {
  state.setup = setup;
  app.innerHTML = `<div class="auth-page"><aside class="auth-story"><div class="logo"><img src="/mark.svg" alt="">Spend Control</div><div class="auth-copy"><div class="eyebrow">A more considered approach</div><h1>Less noise.<br>More direction.</h1><p>A quiet workspace for advertising that learns, adapts, and moves your business forward.</p><div class="auth-art" aria-hidden="true"><div class="auth-block"></div><div class="auth-block b"><div class="abstract-line"></div><div class="abstract-line short"></div></div><div class="auth-block c"></div></div></div><p class="auth-story-foot">Designed for clarity. Built for the everyday.</p></aside><main class="auth-form-wrap" id="main"><form class="auth-form" data-form="auth"><div class="eyebrow">Your workspace awaits</div><h2 class="mt">${setup ? "Make yourself at home." : "Welcome back."}</h2><p>${setup ? "Create your owner account to get started." : "A clear view of your advertising is just ahead."}</p><div class="form-error" role="alert"></div>${setup ? field("token", "Workspace setup token", "", { required: true, type: "password", help: "Use the token created on your server during installation." }) : ""}${field("password", setup ? "Choose a password" : "Password", "", { required: true, type: "password", help: setup ? "Use at least 12 characters." : "" })}<button class="btn primary">${setup ? "Create workspace" : "Open workspace"}${icon("arrow", 15)}</button><p class="auth-help">${icon("shield", 13)} Owner access. Credentials stay in your workspace.</p></form></main></div>`;
}
async function init() {
  try {
    const s = await api("/session");
    state.csrf = s.csrf;
    if (s.authenticated) await refresh();
    else authPage(s.setupRequired);
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
