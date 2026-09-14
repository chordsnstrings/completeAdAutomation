import { AppError } from '../app/types.ts';
import type { UsageRate } from '../app/usage.ts';

export const ROLES = {
  'brand-researcher': 'Brand researcher', 'performance-analyst': 'Performance analyst',
  'creative-strategist': 'Creative strategist', copywriter: 'Copywriter',
  'creative-director': 'Creative director', 'video-producer': 'Video producer',
  'voice-producer': 'Voice producer', 'creative-reviewer': 'Creative reviewer',
  'community-manager': 'Community manager', 'response-reviewer': 'Response reviewer',
  'media-planner': 'Media planner', 'budget-analyst': 'Budget analyst',
  'experiment-evaluator': 'Experiment evaluator', 'learning-curator': 'Learning curator',
} as const;
export type Role = keyof typeof ROLES;
export type AgentMode = 'off' | 'shadow' | 'review' | 'auto';
export type Adapter = 'responses' | 'chat' | 'anthropic' | 'gemini' | 'speech';
export type Capability = 'text' | 'vision' | 'json' | 'speech';
export interface ModelConfig {
  id: string; version: number; name: string; provider: string; adapter: Adapter;
  endpoint: string; model: string; capabilities: Capability[]; rate: UsageRate;
  maxInputTokens: number; maxOutputTokens: number; timeoutMs: number;
  concurrency: number; fallbacks: string[]; voice: string; jsonMode: 'schema' | 'object' | 'prompt';
  createdAt: string; verifiedAt: string; builtin?: string;
}
export interface RoleBinding { modelId: string; dailyUsd: number; maxRequestUsd: number; enabled: boolean }
export interface StudioConfig {
  version: number; mode: AgentMode; maxRunUsd: number; dailyUsd: number;
  concurrency: number; analysisHours: number; autoLearn: boolean;
  bindings: Partial<Record<Role, RoleBinding>>;
}
export interface FrozenConfig {
  video?: { provider: 'minimax' | 'seedance' | 'veo'; model: string; usdPerSecond: number };
  config: StudioConfig; models: Partial<Record<Role, ModelConfig>>;
  fallbacks: Record<string, ModelConfig[]>;
}
export interface AgentRun {
  id: string; brandId: string; campaignRunId: string; experimentId: string;
  kind: 'analysis' | 'campaign' | 'experiment'; state: 'queued' | 'running' | 'review' | 'complete' | 'failed' | 'cancelled' | 'uncertain';
  createdAt: string; updatedAt: string; approvedAt: string; error: string;
  snapshot: FrozenConfig; context: Record<string, unknown>; memoryVersion: string;
  quote: WorkflowQuote;
}
export interface AgentTask {
  id: string; runId: string; brandId: string; role: Role; operation: string;
  state: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
  dependencies: string[]; stageId: string; creativeId: string; due: number;
  lease: string; leaseUntil: number; attempt: number; createdAt: string;
  completedAt: string; error: string; output: unknown;
}
export interface WorkflowQuote {
  currency: 'USD'; rows: Array<{ role: string; model: string; requests: number; inputTokens: number; outputTokens: number; videoSeconds: number; typicalUsd: number; upperUsd: number }>;
  typicalUsd: number; upperUsd: number; allowanceUsd: number; fits: boolean;
  assumptions: string[];
}
export type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: unknown[]; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; minimum?: number; maximum?: number };
export const strSchema: Schema = { type: 'string', maxLength: 4000 };
export const stringsSchema: Schema = { type: 'array', items: strSchema, maxItems: 20 };
export function objectSchema(properties: Record<string, Schema>): Schema { return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }; }
export const INSIGHT_SCHEMA = objectSchema({ summary: strSchema, recommendations: stringsSchema, sourceIds: stringsSchema, confidence: { type: 'number', minimum: 0, maximum: 1 } });
export const DIRECTOR_SCHEMA = objectSchema({ summary: strSchema, approved: { type: 'boolean' }, findings: stringsSchema, sourceIds: stringsSchema, confidence: { type: 'number', minimum: 0, maximum: 1 } });
export const BUDGET_SCHEMA = objectSchema({ summary: strSchema, action: { type: 'string', enum: ['hold', 'allow-scale', 'iterate'] }, sourceIds: stringsSchema, confidence: { type: 'number', minimum: 0, maximum: 1 } });
/** Validate the deliberately small schema dialect used by the application, even when a provider claims structured output. */
export function validateOutput(value: unknown, schema: Schema, path = 'result', depth = 0): void {
  if (depth > 20) throw new AppError('Model output exceeds the schema depth.');
  const fail = (why: string): never => { throw new AppError(`Invalid model output at ${path}: ${why}.`); };
  if (schema.enum && !schema.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) fail('unsupported value');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!Object.hasOwn(o, k)) fail(`missing ${k}`);
    for (const [k, v] of Object.entries(o)) {
      if (schema.properties?.[k]) validateOutput(v, schema.properties[k], `${path}.${k}`, depth + 1);
      else if (schema.additionalProperties === false) fail(`unexpected ${k}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('expected an array');
    const a = value as unknown[];
    if (a.length < (schema.minItems ?? 0) || a.length > (schema.maxItems ?? 100)) fail('invalid item count');
    if (schema.items) a.forEach((v, i) => validateOutput(v, schema.items!, `${path}[${i}]`, depth + 1));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('expected text');
    const s = value as string;
    if (s.length < (schema.minLength ?? 0) || s.length > (schema.maxLength ?? 20000)) fail('invalid text length');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))) fail('expected a finite number');
    if ((value as number) < (schema.minimum ?? -Infinity) || (value as number) > (schema.maximum ?? Infinity)) fail('outside allowed range');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail('expected a boolean');
}
export const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function bounded(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new AppError(`${label} must be between ${min} and ${max}.`);
  return n;
}
export function text(value: unknown, label: string, max = 250, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AppError(`Enter a valid ${label}.`);
  return value.trim();
}
