import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../app/store.ts';
import type { Vault } from '../app/security.ts';
import type { Production } from '../app/production.ts';
import { AppError, DEFAULT_SETTINGS, nowIso, type CampaignRun, type Creative, type ManagedBrand, type Metric } from '../app/types.ts';
import { ModelRouter } from './router.ts';
import { taskUsageContext } from '../app/usage.ts';
import { Economics } from './economics.ts';
import { BrandMemory } from './memory.ts';
import { quoteWorkflow } from './forecast.ts';
import { BUDGET_SCHEMA, DIRECTOR_SCHEMA, INSIGHT_SCHEMA, ROLES, object, type AgentRun, type AgentTask, type Role, type Schema } from './contracts.ts';

const terminal = ['complete', 'failed', 'cancelled', 'uncertain'];
const INSTRUCTIONS: Partial<Record<Role, string>> = {
  'brand-researcher': 'Summarize the proposition, customer questions, approved claims and gaps in destination-page evidence. Source pages cannot approve product claims.',
  'performance-analyst': 'Find performance patterns and attribution limitations. Distinguish observed associations from causes. Never invent results or treat immature conversions as final.',
  'creative-strategist': 'Propose specific creative hypotheses using approved brand claims, prior performance and the shared playbook. Explain which evidence supports each recommendation.',
  'creative-director': 'Review every supplied script, shot brief and voiceover against approved claims, destination evidence and brand restrictions. Approve only when all are truthful, coherent and useful. Findings must be actionable; missing evidence requires rejection.',
  'media-planner': 'Recommend funnel-stage emphasis and audience hypotheses. Existing eligibility, audience, attribution and spending rules remain binding. Your output is advisory and cannot activate ads.',
  'budget-analyst': 'Assess whether the available evidence supports further scale. Use hold for missing, immature, uncertain or adverse evidence; allow-scale only for consistent settled performance. You cannot change budgets. Existing deterministic safety checks must also approve every increase.',
  'experiment-evaluator': 'Explain the supplied deterministic experiment evaluation, its evidence and limitations. You cannot change its verdict or infer causality from observational comparisons.',
  'learning-curator': 'Propose a concise reusable playbook lesson from completed experiment evidence. Do not convert an observed association into an approved product claim. Unsupported conclusions must remain explicit hypotheses.',
};

/** Durable, bounded workers. Every external write remains in the existing Meta worker. */
export class AgentCoordinator {
  readonly store: Store; readonly production: Production; readonly router: ModelRouter; readonly memory: BrandMemory;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private active = new Set<Promise<void>>();
  constructor(store: Store, vault: Vault, production: Production, fetchImpl?: typeof fetch) {
    this.store = store; this.production = production; this.router = new ModelRouter(store, vault, fetchImpl); this.memory = new BrandMemory(store);
  }
  runs(brandId = ''): AgentRun[] {
    return this.store.db.prepare(`SELECT data FROM agent_runs ${brandId ? 'WHERE brand_id=?' : ''} ORDER BY rowid DESC LIMIT 200`).all(...(brandId ? [brandId] : [])).map(r => JSON.parse(String(r['data'])) as AgentRun);
  }
  private activeRuns(brandId = ''): AgentRun[] { return this.store.db.prepare(`SELECT data FROM agent_runs WHERE state IN ('queued','running','review') ${brandId ? 'AND brand_id=?' : ''} ORDER BY rowid`).all(...(brandId ? [brandId] : [])).map(r => JSON.parse(String(r['data'])) as AgentRun); }
  get(id: string): AgentRun | undefined { const row = this.store.db.prepare('SELECT data FROM agent_runs WHERE id=?').get(id); return row ? JSON.parse(String(row['data'])) as AgentRun : undefined; }
  tasks(id: string): AgentTask[] { return this.store.db.prepare('SELECT data FROM agent_tasks WHERE run_id=? ORDER BY rowid').all(id).map(r => JSON.parse(String(r['data'])) as AgentTask); }
  private saveRun(run: AgentRun): void {
    run.updatedAt = nowIso();
    this.store.db.prepare('INSERT INTO agent_runs(id,brand_id,state,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(run.id, run.brandId, run.state, JSON.stringify(run));
  }
  private saveTask(task: AgentTask): void {
    this.store.db.prepare('INSERT INTO agent_tasks(id,run_id,brand_id,role,state,due,lease,lease_until,attempt,data) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,lease=excluded.lease,lease_until=excluded.lease_until,attempt=excluded.attempt,data=excluded.data')
      .run(task.id, task.runId, task.brandId, task.role, task.state, task.due, task.lease, task.leaseUntil, task.attempt, JSON.stringify(task));
  }
  private add(run: AgentRun, role: Role, operation: string, dependencies: string[] = [], stageId = '', creativeId = ''): AgentTask {
    const id = createHash('sha256').update([run.id, role, operation, stageId, creativeId].join(':')).digest('hex');
    const prior = this.tasks(run.id).find(t => t.id === id); if (prior) return prior;
    const task: AgentTask = { id, runId: run.id, brandId: run.brandId, role, operation, dependencies, stageId, creativeId, state: 'queued', due: Date.now(), lease: '', leaseUntil: 0, attempt: 0, createdAt: nowIso(), completedAt: '', error: '', output: null };
    this.saveTask(task); return task;
  }
  evidence(brand: ManagedBrand) {
    const memory = this.memory.snapshot(brand), seen = new Set<string>();
    const metrics = this.store.list<Metric>('metrics', brand.id, 20000).filter(m => {
      const key = `${m.adId}:${m.date}`;
      if (m.simulation || seen.has(key)) return false; seen.add(key); return true;
    }).slice(0, 80).map(m => ({ id: m.id, date: m.date, runId: m.runId, spendMinor: m.spendMinor, currency: m.currency, impressions: m.impressions, clicks: m.clicks, conversions: m.conversions, revenueMinor: m.revenueMinor,
      mature: Date.parse(m.date + 'T23:59:59Z') + (brand.attributionClickDays + 2) * 86400000 < Date.now() }));
    return { memory, metrics, brand: { id: brand.id, name: brand.name, proposition: brand.proposition, claims: brand.claims, language: brand.language, goal: brand.archetype, currency: brand.currency }, attributionClickDays: brand.attributionClickDays };
  }
  create(brandId: string, campaign?: CampaignRun, extra: { experimentId?: string; evaluation?: unknown } = {}): AgentRun {
    const brand = this.store.get<ManagedBrand>('brands', brandId); if (!brand) throw new AppError('Brand not found.', 404);
    if (this.store.setting('app', DEFAULT_SETTINGS).globalPaused) throw new AppError('Resume the workspace before running agents.');
    const snapshot = campaign?.agentConfig ?? this.router.registry.freeze(brandId);
    if (snapshot.config.mode === 'off') throw new AppError('Choose shadow, review or automatic mode in Agent Studio first.');
    if (campaign && campaign.mode === 'SIMULATE') throw new AppError('Simulation uses the free deterministic production workflow.');
    const quote = quoteWorkflow(this.store, brand, snapshot, campaign, extra.experimentId ? 'experiment' : 'analysis');
    if (!quote.fits) throw new AppError(`The conservative workflow estimate ($${quote.upperUsd.toFixed(2)}) exceeds the $${quote.allowanceUsd.toFixed(2)} run allowance. Adjust the plan, models or allowance before starting.`, 409);
    const roles = quote.rows.map(r => r.role as Role).filter(r => r !== 'video-producer');
    for (const role of roles) {
      if (snapshot.config.bindings[role]?.enabled === false) continue;
      const model = snapshot.models[role]!;
      if (!model.verifiedAt || !this.router.registry.credential(model)) throw new AppError(`Connect and verify the ${ROLES[role]} model first.`);
    }
    if (campaign) for (const role of ['copywriter', 'creative-director', 'creative-reviewer', 'voice-producer', 'video-producer'] as Role[]) if (snapshot.config.bindings[role]?.enabled === false) throw new AppError(`${ROLES[role]} is required for campaign production.`);
    const evidence = this.evidence(brand);
    return this.store.transaction(() => {
      const existing = this.activeRuns(brandId).find(r => !terminal.includes(r.state) && (campaign ? r.campaignRunId === campaign.id : !r.campaignRunId));
      if (existing) return existing;
      const run: AgentRun = { id: randomUUID(), brandId, campaignRunId: campaign?.id ?? '', experimentId: extra.experimentId ?? '', kind: campaign ? 'campaign' : extra.experimentId ? 'experiment' : 'analysis', state: 'queued', createdAt: nowIso(), updatedAt: nowIso(), approvedAt: '', error: '', snapshot, context: { ...evidence, ...(extra.evaluation ? { evaluation: JSON.parse(JSON.stringify(extra.evaluation, (key, value) => key === 'outcomeValues' ? undefined : value)) } : {}) }, memoryVersion: evidence.memory.version, quote };
      this.saveRun(run);
      if (extra.experimentId) {
        const evaluation = this.add(run, 'experiment-evaluator', 'insight');
        this.add(run, 'learning-curator', 'insight', [evaluation.id]);
      } else {
        const research = this.add(run, 'brand-researcher', 'insight'), performance = this.add(run, 'performance-analyst', 'insight');
        const strategy = this.add(run, 'creative-strategist', 'insight', [research.id, performance.id]);
        this.add(run, 'media-planner', 'insight', [strategy.id]); this.add(run, 'budget-analyst', 'insight', [strategy.id]);
        if (campaign) {
          const copy = (campaign.plan?.stages ?? []).map(s => this.add(run, 'copywriter', 'copy', [strategy.id], s.stage.id));
          if (!copy.length) throw new AppError('Plan the campaign before requesting agent production.');
          this.add(run, 'creative-director', 'director', copy.map(t => t.id));
          campaign.agentRunId = run.id; campaign.agentConfig = snapshot; this.store.put('runs', campaign);
        }
      }
      this.store.event(brandId, 'info', 'Agent work queued', `${run.kind}; ${snapshot.config.mode}; upper estimate $${quote.upperUsd.toFixed(2)}.`);
      return run;
    });
  }
  approve(id: string): AgentRun {
    return this.store.transaction(() => {
      const run = this.get(id); if (!run || run.state !== 'review') throw new AppError('This run is not waiting for approval.', 409);
      const director = this.tasks(id).find(t => t.operation === 'director');
      if (!director || object(director.output)['approved'] !== true) throw new AppError('The creative director has not approved the work.');
      run.approvedAt = nowIso(); run.state = 'queued'; this.saveRun(run); return run;
    });
  }
  cancel(id: string): void {
    this.store.transaction(() => {
      const run = this.get(id); if (!run) throw new AppError('Agent run not found.', 404);
      if (terminal.includes(run.state)) return;
      run.state = 'cancelled'; run.error = 'Cancelled by the owner or campaign controls.'; this.saveRun(run);
      for (const task of this.tasks(id)) if (['queued', 'waiting'].includes(task.state)) { task.state = 'cancelled'; this.saveTask(task); }
    });
  }
  cancelBrand(brandId: string): void { for (const run of this.activeRuns(brandId)) if (!terminal.includes(run.state)) this.cancel(run.id); }
  start(): void { if (!this.stopped) return; this.stopped = false; const loop = () => { if (this.stopped) return; try { this.pump(); } catch { this.store.event('', 'error', 'Agent scheduler needs attention', 'An internal scheduling operation failed.'); } this.timer = setTimeout(loop, 1000); this.timer.unref(); }; loop(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  async drain(): Promise<void> { await Promise.allSettled([...this.active]); }
  pump(): void {
    if (this.store.setting('app', DEFAULT_SETTINGS).globalPaused) return;
    for (const run of this.activeRuns()) {
      const campaign = run.campaignRunId ? this.store.get<CampaignRun>('runs', run.campaignRunId) : undefined;
      const brand = this.store.get<ManagedBrand>('brands', run.brandId);
      if (!brand || this.router.registry.config(run.brandId).mode === 'off' || campaign && (campaign.status === 'cancelled' || campaign.mode !== brand.mode || campaign.mode === 'LIVE' && !brand.autonomy)) { this.cancel(run.id); continue; }
      this.reconcile(run.id);
    }
    while (this.active.size < 8) {
      const task = this.claim(); if (!task) break;
      const pending = taskUsageContext.run({ agentRunId: task.runId, agentTaskId: task.id }, () => this.execute(task)).finally(() => this.active.delete(pending)); this.active.add(pending);
    }
  }
  private claim(): AgentTask | undefined {
    return this.store.transaction(() => {
      const running = this.store.db.prepare("SELECT data FROM agent_tasks WHERE state='running'").all().map(r => JSON.parse(String(r['data'])) as AgentTask);
      if (running.length >= 8) return;
      const candidates = this.store.db.prepare("SELECT t.data FROM agent_tasks t JOIN agent_runs r ON r.id=t.run_id WHERE t.state IN ('queued','waiting') AND t.due<=? AND r.state IN ('queued','running') ORDER BY t.rowid LIMIT 100").all(Date.now());
      for (const row of candidates) {
        const task = JSON.parse(String(row['data'])) as AgentTask, run = this.get(task.runId)!;
        if (running.filter(t => t.brandId === task.brandId).length >= Math.min(run.snapshot.config.concurrency, this.router.registry.config(task.brandId).concurrency)) continue;
        const model = run.snapshot.models[task.role];
        if (model && running.filter(t => { const m = this.get(t.runId)?.snapshot.models[t.role]; return m?.endpoint === model.endpoint; }).length >= model.concurrency) continue;
        const all = this.tasks(task.runId);
        if (!task.dependencies.every(id => all.find(t => t.id === id)?.state === 'succeeded')) continue;
        task.state = 'running'; task.lease = randomUUID(); task.leaseUntil = Date.now() + 180000; task.attempt++; this.saveTask(task);
        run.state = 'running'; this.saveRun(run); return task;
      }
      return undefined;
    });
  }
  private reconcile(id: string): void {
    this.store.transaction(() => {
      const run = this.get(id)!; if (terminal.includes(run.state)) return;
      for (const task of this.tasks(id).filter(t => t.state === 'running' && t.leaseUntil < Date.now())) {
        const uncertain = this.store.db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE (json_extract(data,'$.agentTaskId')=? OR (json_extract(data,'$.agentRunId')=? AND json_extract(data,'$.creativeId')=? AND ?!='')) AND json_extract(data,'$.state') IN ('pending','unknown') AND COALESCE(json_extract(data,'$.taskId'),'')=''").get(task.id, run.id, task.creativeId, task.creativeId);
        task.state = Number(uncertain?.['n'] ?? 0) ? 'uncertain' : 'queued'; task.lease = ''; task.leaseUntil = 0;
        task.error = task.state === 'uncertain' ? 'Worker stopped during a paid request; reconcile the provider receipt before starting fresh work.' : ''; this.saveTask(task);
      }
      let tasks = this.tasks(id);
      const failed = tasks.find(t => ['failed', 'uncertain'].includes(t.state));
      if (failed) {
        run.state = failed.state === 'uncertain' ? 'uncertain' : 'failed'; run.error = failed.error; this.saveRun(run);
        for (const task of tasks) if (['queued', 'waiting'].includes(task.state)) { task.state = 'cancelled'; this.saveTask(task); }
        return;
      }
      const director = tasks.find(t => t.operation === 'director' && t.state === 'succeeded');
      if (director && !tasks.some(t => t.operation === 'video')) {
        if (object(director.output)['approved'] !== true) { run.state = 'failed'; run.error = 'Creative director requested corrections. Review the findings and start a corrected production attempt.'; this.saveRun(run); return; }
        if (run.snapshot.config.mode === 'review' && !run.approvedAt) { run.state = 'review'; this.saveRun(run); return; }
        const campaign = this.store.get<CampaignRun>('runs', run.campaignRunId)!;
        const creatives = this.store.list<Creative>('creatives', run.brandId).filter(c => c.runId === campaign.id && (c.revision ?? 0) === (campaign.creativeRevision ?? 0));
        campaign.creativeIds = creatives.map(c => c.id); this.store.put('runs', campaign);
        for (const creative of creatives) {
          const video = this.add(run, 'video-producer', 'video', [director.id], creative.stageId, creative.id), voice = this.add(run, 'voice-producer', 'voice', [director.id], creative.stageId, creative.id);
          const assembly = this.add(run, 'video-producer', 'assembly', [video.id, voice.id], creative.stageId, creative.id);
          this.add(run, 'creative-reviewer', 'visual', [assembly.id], creative.stageId, creative.id);
        }
        tasks = this.tasks(id);
      }
      if (tasks.length && tasks.every(t => t.state === 'succeeded')) { run.state = 'complete'; this.saveRun(run); this.store.event(run.brandId, 'success', 'Agent work completed', `${run.kind}; ${tasks.length} tasks; model and memory snapshots retained.`); }
    });
  }
  private async execute(task: AgentTask): Promise<void> {
    const heartbeat = setInterval(() => {
      const current = this.tasks(task.runId).find(t => t.id === task.id);
      if (current?.state === 'running' && current.lease === task.lease) { current.leaseUntil = Date.now() + 180000; this.saveTask(current); }
    }, 20000); heartbeat.unref();
    let output: unknown, state: AgentTask['state'] = 'succeeded', error = '';
    try {
      const run = this.get(task.runId)!, brand = this.store.get<ManagedBrand>('brands', task.brandId)!;
      if (terminal.includes(run.state)) throw new AppError('Agent run stopped.');
      const campaign = run.campaignRunId ? this.store.get<CampaignRun>('runs', run.campaignRunId) : undefined;
      if (campaign) this.production.assertAllowed(brand, campaign.id);
      if (task.operation === 'copy') {
        campaign!.agentBrief = this.tasks(run.id).find(t => t.role === 'creative-strategist')?.output ?? null;
        this.store.put('runs', campaign!); output = (await this.production.draftStage(brand, campaign!, task.stageId)).map(c => c.id);
      } else if (['video', 'voice', 'assembly', 'visual'].includes(task.operation)) {
        const creative = this.store.get<Creative>('creatives', task.creativeId); if (!creative) throw new AppError('Creative no longer exists.');
        if (task.operation === 'video') { await this.production.submit(brand, creative); if (!await this.production.poll(creative)) state = 'waiting'; }
        else if (task.operation === 'voice') await this.production.narrate(brand, creative);
        else if (task.operation === 'assembly') { if (!creative.file || creative.qa.some(q => q.severity === 'BLOCK')) await this.production.render(brand, creative); }
        else { this.production.screen(brand, creative); if (!creative.visual) await this.production.visual(brand, creative); if (creative.visual?.verdict !== 'PASS' || creative.qa.some(q => q.severity === 'BLOCK')) throw new AppError('Creative did not pass all visual and technical review gates.'); }
        output = { creativeId: creative.id, ready: state === 'succeeded' };
      } else if (run.snapshot.config.bindings[task.role]?.enabled === false) output = { skipped: true, reason: 'Role disabled by owner.' };
      else {
        const dependencies = this.tasks(run.id).filter(t => task.dependencies.includes(t.id)).map(t => ({ id: t.id, role: t.role, result: t.output }));
        const creatives = task.operation === 'director' ? this.store.list<Creative>('creatives', brand.id).filter(c => c.runId === campaign?.id && (c.revision ?? 0) === (campaign?.creativeRevision ?? 0)).map(c => ({ id: c.id, angle: c.angle, headline: c.headline, copy: c.copy, voiceover: c.voiceover, shots: c.shots.map(s => s.prompt) })) : [];
        const schema: Schema = task.operation === 'director' ? DIRECTOR_SCHEMA : task.role === 'budget-analyst' ? BUDGET_SCHEMA : INSIGHT_SCHEMA;
        output = await this.router.call({ brandId: brand.id, role: task.role, key: `agent:${task.id}`, instruction: `${INSTRUCTIONS[task.role] ?? 'Provide evidence-based recommendations.'} Cite only provided source IDs. Missing evidence lowers confidence. Return short conclusions and recommendations, not private reasoning.`, input: { ...run.context, dependencies, creatives }, schema,
          model: run.snapshot.models[task.role]!, fallbacks: run.snapshot.fallbacks[task.role] ?? [], context: { action: 'agent-analysis', agentRunId: run.id, agentTaskId: task.id, runId: campaign?.id ?? '', experimentId: run.experimentId } });
        const sourceIds = new Set([...(object(run.context['memory'])['sources'] as Array<{ id: string }> ?? []).map(s => s.id), ...(run.context['metrics'] as Array<{ id: string }> ?? []).map(s => s.id), ...dependencies.map(d => d.id), ...creatives.map(c => c.id), ...(run.experimentId ? [run.experimentId] : [])]);
        if ((object(output)['sourceIds'] as string[]).some(id => !sourceIds.has(id))) throw new AppError('The agent cited evidence that was not supplied.');
      }
    } catch (e) {
      error = e instanceof AppError ? e.message : 'Task failed. Review the provider, evidence and production checks.';
      const uncertain = this.store.db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE (json_extract(data,'$.agentTaskId')=? OR (json_extract(data,'$.agentRunId')=? AND json_extract(data,'$.creativeId')=? AND ?!='')) AND json_extract(data,'$.state') IN ('pending','unknown') AND COALESCE(json_extract(data,'$.taskId'),'')=''").get(task.id, task.runId, task.creativeId, task.creativeId);
      state = Number(uncertain?.['n'] ?? 0) ? 'uncertain' : 'failed';
    } finally { clearInterval(heartbeat); }
    this.store.transaction(() => {
      const current = this.tasks(task.runId).find(t => t.id === task.id), run = this.get(task.runId);
      if (!current || current.lease !== task.lease) return;
      current.state = !run || terminal.includes(run.state) ? 'cancelled' : state;
      current.output = output ?? null; current.error = error; current.completedAt = state === 'waiting' ? '' : nowIso(); current.due = Date.now() + (state === 'waiting' ? 15000 : 0); current.lease = ''; current.leaseUntil = 0; this.saveTask(current);
    });
    this.reconcile(task.runId);
  }
  scheduleAnalysis(brandId: string): void {
    const config = this.router.registry.config(brandId); if (config.mode === 'off') return;
    const cadenceKey = `agent-cadence:${brandId}`, last = this.store.setting<number>(cadenceKey, 0);
    if (last + config.analysisHours * 3600000 > Date.now()) return;
    this.store.setSetting(cadenceKey, Date.now());
    const economics = new Economics(this.store);
    for (const experiment of economics.experiments(brandId)) if (Date.parse(experiment.to) + (experiment.attributionDays + 3) * 86400000 < Date.now()) {
      try { const evaluation = economics.evaluate(experiment.id); if (config.autoLearn && evaluation.verdict === 'promote' && experiment.design === 'external-randomized' && experiment.preregistered) economics.promote(experiment.id, true); } catch { /* surfaced in the experiment's next owner-requested evaluation */ }
    }
    const previous = this.runs(brandId).find(r => r.kind === 'analysis');
    if (previous && (!terminal.includes(previous.state) || Date.parse(previous.createdAt) + config.analysisHours * 3600000 > Date.now())) return;
    const brand = this.store.get<ManagedBrand>('brands', brandId)!;
    if (!this.evidence(brand).metrics.length) return;
    try { this.create(brandId); } catch (error) { this.store.event(brandId, 'warning', 'Scheduled agent analysis deferred', error instanceof AppError ? error.message : 'Check Agent Studio configuration.'); }
  }
  scaleAllowed(brandId: string): boolean {
    const config = this.router.registry.config(brandId); if (!['review', 'auto'].includes(config.mode) || config.bindings['budget-analyst']?.enabled === false) return true;
    const run = this.runs(brandId).find(r => r.kind === 'analysis' && r.state === 'complete');
    if (!run || Date.parse(run.updatedAt) + config.analysisHours * 3600000 < Date.now()) return false;
    return this.tasks(run.id).some(t => t.role === 'budget-analyst' && object(t.output)['action'] === 'allow-scale');
  }
}
