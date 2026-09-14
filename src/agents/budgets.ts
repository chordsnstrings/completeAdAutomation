import type { Store } from '../app/store.ts';
import { AppError, nowIso } from '../app/types.ts';
import type { UsageContext } from '../app/usage.ts';
import type { StudioConfig, Role, AgentRun } from './contracts.ts';

export function exposure(store: Store, where = '', values: Array<string | number> = []) {
  const receipt = `(SELECT json_extract(d.data,'$.amountMicros') FROM documents d WHERE d.collection='costAdjustments' AND json_extract(d.data,'$.kind')='receipt' AND json_extract(d.data,'$.usageId')=ai_usage.id ORDER BY json_extract(d.data,'$.version') DESC LIMIT 1)`;
  const row = store.db.prepare(`SELECT COALESCE(SUM(COALESCE(${receipt}, CASE WHEN json_extract(data,'$.costStatus')='not-charged' THEN 0 ELSE COALESCE(json_extract(data,'$.costMicros'),json_extract(data,'$.estimatedMicros'),0) END)),0) AS micros,
    SUM(CASE WHEN ${receipt} IS NULL AND json_extract(data,'$.costStatus')!='not-charged' AND json_extract(data,'$.costMicros') IS NULL AND json_extract(data,'$.estimatedMicros') IS NULL THEN 1 ELSE 0 END) AS unknown FROM ai_usage ${where ? `WHERE ${where}` : ''}`).get(...values);
  return { micros: Number(row?.['micros'] ?? 0), unknown: Number(row?.['unknown'] ?? 0) };
}
/** Called inside the same IMMEDIATE transaction as the new paid request. */
export function assertAiBudget(store: Store, context: UsageContext, estimatedMicros: number | null): void {
  const day = nowIso().slice(0, 10), dateSql = 'substr(created_at,1,10)=?';
  const global = store.setting<StudioConfig | null>('studio', null);
  const config = store.setting<StudioConfig | null>(`studio:${context.brandId}`, global);
  const workspace = store.setting<number | null>('aiWorkspaceDailyUsd', null);
  const check = (limit: number | undefined | null, name: string, sql: string, args: Array<string | number>) => {
    if (limit === undefined || limit === null) return;
    const used = exposure(store, sql, args);
    if (estimatedMicros === null || used.unknown) throw new AppError(`${name}: reconcile unpriced requests before increasing AI exposure.`, 409);
    if (used.micros + estimatedMicros > Math.floor(limit * 1e6)) throw new AppError(`${name} reached. No additional paid request was sent.`, 409);
  };
  check(workspace, 'Workspace daily AI allowance', dateSql, [day]);
  if (config) {
    check(config.dailyUsd, 'Brand daily AI allowance', `${dateSql} AND brand_id=?`, [day, context.brandId]);
    const role = context.agentRole as Role, binding = config.bindings[role];
    if (binding) {
      if (estimatedMicros !== null && estimatedMicros > binding.maxRequestUsd * 1e6) throw new AppError('This request exceeds the selected role’s per-request allowance.');
      check(binding.dailyUsd, 'Role daily AI allowance', `${dateSql} AND brand_id=? AND json_extract(data,'$.agentRole')=?`, [day, context.brandId, role]);
    }
  }
  if (context.agentRunId) {
    const row = store.db.prepare('SELECT data FROM agent_runs WHERE id=?').get(context.agentRunId);
    if (!row) throw new AppError('Agent run no longer exists.', 409);
    const run = JSON.parse(String(row['data'])) as AgentRun;
    if (['cancelled', 'failed', 'uncertain'].includes(run.state)) throw new AppError('Agent run is stopped.', 409);
    check(run.snapshot.config.maxRunUsd, 'Agent run allowance', "json_extract(data,'$.agentRunId')=?", [run.id]);
  }
}
