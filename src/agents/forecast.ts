import type { Store } from '../app/store.ts';
import { DEFAULT_SETTINGS, type ManagedBrand, type CampaignRun, type Settings } from '../app/types.ts';
import type { FrozenConfig, Role, WorkflowQuote } from './contracts.ts';
import { requestEstimate } from './router.ts';
import { SeedanceProvider } from '../generation/seedance.ts';
import { VeoProvider } from '../generation/veo.ts';

export function quoteWorkflow(store: Store, brand: ManagedBrand, frozen: FrozenConfig, campaign?: CampaignRun, kind: 'analysis' | 'experiment' = 'analysis'): WorkflowQuote {
  const roles: Role[] = kind === 'experiment' ? ['experiment-evaluator', 'learning-curator'] : ['brand-researcher', 'performance-analyst', 'creative-strategist', 'media-planner', 'budget-analyst'];
  if (campaign) roles.push('copywriter', 'creative-director', 'creative-reviewer');
  const stages = campaign?.plan?.stages.length ?? 1, creatives = stages * brand.creativesPerCycle;
  const rows: WorkflowQuote['rows'] = [];
  for (const role of roles) {
    if (frozen.config.bindings[role]?.enabled === false) continue;
    const model = frozen.models[role]!;
    const requests = role === 'copywriter' ? stages : role === 'creative-reviewer' ? creatives : 1;
    const typicalInput = Math.min(model.maxInputTokens, role === 'brand-researcher' ? 16000 : 6000);
    const typicalOutput = Math.min(model.maxOutputTokens, role === 'copywriter' ? 2500 : 1000);
    const typical = (typicalInput * (model.rate.input ?? 0) + typicalOutput * (model.rate.output ?? 0)) / 1e6;
    const upper = requestEstimate(model, model.maxInputTokens) / 1e6 + (frozen.fallbacks[role] ?? []).reduce((n, fallback) => n + requestEstimate(fallback, fallback.maxInputTokens) / 1e6, 0);
    rows.push({ role, model: model.model, requests, inputTokens: typicalInput * requests, outputTokens: typicalOutput * requests, videoSeconds: 0, typicalUsd: typical * requests, upperUsd: upper * requests });
  }
  if (campaign) {
    const settings = { ...DEFAULT_SETTINGS, ...store.setting<Partial<Settings>>('app', {}) };
    const seconds = creatives * 16;
    const video = frozen.video ?? {provider: settings.provider,model: settings.videoModel,usdPerSecond: settings.h3UsdPerSecond ?? 0.08};
    const spec = {modelId:video.model,prompt:'A planned eight-second product shot.',durationSeconds:8,aspectRatio:'9:16' as const,resolution:'720p' as const,audio:false};
    const cost = video.provider === 'minimax' ? 8 * video.usdPerSecond : video.provider === 'seedance' ? new SeedanceProvider({apiKey:''}).estimateCost(spec).microUnits / 1e6 : new VeoProvider({projectId:'quote-only',storageUri:'gs://quote-only/output',accessToken:''}).estimateCost(spec).microUnits / 1e6;
    rows.push({ role: 'video-producer', model: video.model, requests: creatives * 2, inputTokens: 0, outputTokens: 0, videoSeconds: seconds, typicalUsd: cost * creatives * 2, upperUsd: cost * creatives * 2 });
    const voice = frozen.models['voice-producer']!, rate = voice.rate.perMillionCharacters ?? 15;
    rows.push({ role: 'voice-producer', model: voice.model, requests: creatives, inputTokens: 0, outputTokens: 0, videoSeconds: 0, typicalUsd: creatives * 250 * rate / 1e6, upperUsd: creatives * 3000 * rate / 1e6 });
  }
  const typicalUsd = rows.reduce((n, row) => n + row.typicalUsd, 0), upperUsd = rows.reduce((n, row) => n + row.upperUsd, 0);
  return { currency: 'USD', rows, typicalUsd, upperUsd, allowanceUsd: frozen.config.maxRunUsd, fits: upperUsd <= frozen.config.maxRunUsd,
    assumptions: ['Initial production only; each revision requires a new quote and allowance.', 'Upper estimate uses configured input/output ceilings and explicit fallback attempts; no cache discount is assumed.', 'Typical estimates are planning assumptions, not provider invoices.', 'Video variants are assembled locally. Advertising spend is separate.', 'Video estimates use the saved provider catalogue and output specification.'] };
}
