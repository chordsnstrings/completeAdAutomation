import {
  FUNNEL_TEMPLATES,
  FUNNEL_TEMPLATE_IDS,
  AUDIENCE_POOLS,
  assessFunnelBudget,
  recommendFunnel,
  resolveStageSpec,
  splitMinor,
} from "../funnel/templates.ts";
import type { FunnelTemplateId, FunnelPlan } from "../funnel/templates.ts";
import { currencyOffset } from "../meta/publish.ts";
import type { ManagedBrand } from "./types.ts";
import { AppError } from "./types.ts";

export function planFor(
  brand: ManagedBrand,
  override?: FunnelTemplateId,
): FunnelPlan {
  const offset = currencyOffset(brand.currency);
  const input = {
    dailyBudgetMajor: brand.spend.dailyBudgetMinor / offset,
    archetype: brand.archetype,
    targetCpaMajor: (brand.spend.targetCpaMinor ?? 1) / offset,
    currency: brand.currency,
  };
  const recommendation = recommendFunnel({
    ...input,
    purchasesLast180d: brand.purchasesLast180d,
    warmPoolSize: brand.warmPoolSize,
    hasCustomerList: brand.assets === "customers",
    valueSpreadMaterial: brand.spend.targetRoas !== undefined,
  });
  const templateId =
    override ??
    (brand.funnel === "auto" ? recommendation.templateId : brand.funnel);
  const template = FUNNEL_TEMPLATES[templateId];
  if (!template) throw new AppError("Unknown funnel.");
  const assessment = assessFunnelBudget(templateId, input);
  const budgets = splitMinor(
    brand.spend.dailyBudgetMinor,
    template.stages.map((s) => s.budgetShare),
  );
  const warnings: string[] = [];
  if (assessment.benchmarksApproximate)
    warnings.push(
      "Some planning costs use USD benchmarks. Actual delivery is measured in your account currency.",
    );
  if (brand.warmPoolSize < template.requiresWarmPool)
    warnings.push(
      `This option needs ${template.requiresWarmPool.toLocaleString()} people in a warm audience.`,
    );
  if (brand.purchasesLast180d < template.requiresPurchaseHistory)
    warnings.push(
      `This option needs ${template.requiresPurchaseHistory} recent conversions.`,
    );
  const unavailable =
    brand.warmPoolSize < template.requiresWarmPool ||
    brand.purchasesLast180d < template.requiresPurchaseHistory;
  return {
    templateId,
    template,
    archetype: brand.archetype,
    assessment,
    recommendation,
    warnings,
    stages: template.stages.map((s, i) => ({
      stage: s,
      spec: resolveStageSpec(s, brand.archetype),
      dailyBudgetMinor: budgets[i] ?? 0,
      arithmetic: assessment.stages.find((a) => a.stageId === s.id)!,
      targetPools: s.target.map((p) => AUDIENCE_POOLS[p]),
      suggestPools: s.suggest.map((p) => AUDIENCE_POOLS[p]),
      excludePools: s.exclude.map((p) => AUDIENCE_POOLS[p]),
    })),
    audiencesToBuild: template.audiences.map((p) => AUDIENCE_POOLS[p]),
    refusal:
      assessment.verdict === "refuse"
        ? assessment.explanation.join(" ")
        : unavailable
          ? warnings.join(" ")
          : undefined,
  };
}
export function allPlans(brand: ManagedBrand): FunnelPlan[] {
  return FUNNEL_TEMPLATE_IDS.map((id) => planFor(brand, id));
}
