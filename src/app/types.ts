import type { Brand } from "../domain/brand.ts";
import type { CreativeGenome } from "../domain/genome.ts";
import type { RuntimeMode } from "../meta/client.ts";
import type {
  FunnelTemplateId,
  FunnelPlan,
  EasyAssets,
} from "../funnel/templates.ts";
import type { AccountContext } from "../meta/publish.ts";

export interface ManagedBrand extends Brand {
  currencyUnitVersion?: 1;
  currency: string;
  timezone: string;
  funnel: FunnelTemplateId | "auto";
  assets: EasyAssets;
  warmPoolSize: number;
  purchasesLast180d: number;
  audienceIds: Record<string, string>;
  autonomy: boolean;
  mode: RuntimeMode;
  language: string;
  generationDailyUsd: number;
  creativesPerCycle: number;
  refreshDays: number;
  privacyPolicyUrl: string;
  websiteDescription: string;
  productImage: string;
  catalogCreativeId: string;
  resultActionType: string;
  leadWebhookUrl: string;
  leadFormLocale: string;
  lifetimeLimitMinor: number;
  attributionClickDays: number;
  lastCheckedAt: string;
  preflight: Check[];
  account?: AccountContext;
  createdAt: string;
  updatedAt: string;
}

export interface Check {
  name: string;
  severity: "PASS" | "WARN" | "BLOCK";
  detail: string;
  remedy?: string;
}
export interface Settings {
  provider: "seedance" | "veo";
  textModel: string;
  textInputUsdPerMillion: number;
  textOutputUsdPerMillion: number;
  videoModel: string;
  googleProject: string;
  googleBucket: string;
  googleRegion: string;
  pollMinutes: number;
  globalPaused: boolean;
  emergencyPending: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  provider: "seedance",
  textModel: "gpt-4.1-mini",
  textInputUsdPerMillion: 0.4,
  textOutputUsdPerMillion: 1.6,
  videoModel: "seedance-1-5-pro-251215",
  googleProject: "",
  googleBucket: "",
  googleRegion: "us-central1",
  pollMinutes: 30,
  globalPaused: false,
  emergencyPending: false,
};
export const SECRET_NAMES = [
  "metaAppId",
  "metaAppSecret",
  "metaToken",
  "openaiKey",
  "seedanceKey",
  "googleServiceAccount",
  "conversionWebhookToken",
  "leadWebhookSecret",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type RunPhase =
  | "plan"
  | "copy"
  | "generate"
  | "poll"
  | "assemble"
  | "screen"
  | "audiences"
  | "publish"
  | "activate"
  | "complete";
export interface CampaignRun {
  creativeRevision?: number;
  correctionFeedback?: string[];
  id: string;
  brandId: string;
  mode: RuntimeMode;
  phase: RunPhase;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "complete"
    | "blocked"
    | "cancelled";
  createdAt: string;
  updatedAt: string;
  nextAt: string;
  plan?: FunnelPlan;
  creativeIds: string[];
  error: string;
  warnings: string[];
  stages: PublishedStage[];
  generationCostUsd: number;
  replacementFor: string;
  repair?: {
    sourceRunId: string;
    stageId: string;
    adId: string;
    lineageId: string;
    attempt: number;
    feedback: string[];
  };
}
export interface PublishedStage {
  activationPending?: boolean;
  stageId: string;
  campaignId: string;
  adSetId: string;
  adIds: string[];
  dailyBudgetMinor: number;
  active: boolean;
  primaryAction: string;
  attributionClickDays: number;
}
export interface Creative {
  revision?: number;
  id: string;
  brandId: string;
  runId: string;
  angle: string;
  headline: string;
  copy: string;
  stageId: string;
  lineageId?: string;
  prompt: string;
  onScreenText: string;
  voiceover: string;
  cta: string;
  genome: CreativeGenome;
  status:
    | "planned"
    | "generating"
    | "rendered"
    | "passed"
    | "blocked"
    | "published";
  taskId: string;
  taskSubmittedAt: string;
  provider: "seedance" | "veo";
  model: string;
  generationEstimateUsd: number;
  outputUri: string;
  file: string;
  poster: string;
  shots: Array<{
    prompt: string;
    taskId: string;
    submittedAt: string;
    outputUri: string;
    file: string;
    status: string;
  }>;
  variants: Record<string, string>;
  videoId: string;
  metaAccountId?: string;
  metaPageId?: string;
  imageHash: string;
  adIds: string[];
  qa: Check[];
  policy: Check[];
  visual: { verdict: "PASS" | "BLOCK"; findings: string[] } | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}
export interface Metric {
  id: string;
  brandId: string;
  runId: string;
  adId: string;
  adSetId: string;
  date: string;
  observedAt: string;
  currency: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueMinor: number;
  attribution: string;
  simulation: boolean;
  videoViews: number;
}
export interface Decision {
  id: string;
  brandId: string;
  runId: string;
  adId: string;
  action: string;
  reason: string;
  createdAt: string;
  applied: boolean;
  simulation: boolean;
  valueMinor?: number;
}
export interface Activity {
  id: string;
  brandId: string;
  kind: "info" | "success" | "warning" | "error";
  title: string;
  detail: string;
  createdAt: string;
}
export interface Lead {
  id: string;
  brandId: string;
  formId: string;
  createdAt: string;
  fields: Record<string, string>;
  delivery: "pending" | "delivered" | "failed";
  deliveredAt: string;
}
export interface Job {
  id: string;
  kind: string;
  entityId: string;
  attempt: number;
  lease: string;
}
export interface Effect {
  key: string;
  state: "pending" | "done" | "failed";
  value: unknown;
  updatedAt: string;
}
export type Collection =
  | "brands"
  | "runs"
  | "creatives"
  | "metrics"
  | "decisions"
  | "activity"
  | "leads"
  | "conversions"
  | "objects"
  | "lineages";
export class AppError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}
export const nowIso = (): string => new Date().toISOString();
export class TransientAppError extends AppError {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 60000) {
    super(message, 429);
    this.retryAfterMs = retryAfterMs;
  }
}
