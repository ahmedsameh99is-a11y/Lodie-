import type { BrandedModel, PlanTier, UserRole } from './types';

export const MAX_CONFIGURABLE_DAILY_TOKENS = 1_000_000;

export const DEFAULT_PLAN_LIMITS: Record<PlanTier, { daily: number; monthly: number }> = {
  free: { daily: 150_000, monthly: 2_500_000 },
  premium: { daily: 250_000, monthly: 4_000_000 },
  developer: { daily: MAX_CONFIGURABLE_DAILY_TOKENS, monthly: 15_000_000 },
};

export const PER_MODEL_DAILY_CAPS: Record<PlanTier, Record<string, number>> = {
  free: {
    'sonic-3': 60_000,
    'sonic-3.5': 50_000,
    'lodie-5.5': 35_000,
    'fables-5.3': 40_000,
    'loody-vision-1': 35_000,
  },
  premium: {
    'sonic-3': 120_000,
    'sonic-3.5': 120_000,
    'lodie-5.5': 100_000,
    'fables-5.3': 100_000,
    'loody-vision-1': 100_000,
  },
  developer: {
    'sonic-3': 500_000,
    'sonic-3.5': 500_000,
    'lodie-5.5': 400_000,
    'fables-5.3': 400_000,
    'loody-vision-1': 400_000,
  },
};

export function getPerModelDailyCap(plan: PlanTier, modelId: string): number {
  const tierCaps = PER_MODEL_DAILY_CAPS[plan] ?? PER_MODEL_DAILY_CAPS.free;
  return tierCaps[modelId] ?? DEFAULT_PLAN_LIMITS[plan]?.daily ?? DEFAULT_PLAN_LIMITS.free.daily;
}

export function getUtcQuotaResetTimestamps(now = new Date()): {
  dailyResetAtUtc: string;
  monthlyResetAtUtc: string;
} {
  const dailyReset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
  const monthlyReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return {
    dailyResetAtUtc: dailyReset.toISOString(),
    monthlyResetAtUtc: monthlyReset.toISOString(),
  };
}

export const COMMERCIAL_PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceUsdMonthly: 0,
    audience: 'Full 5-model workspace chat, multimodal vision, file analysis & core studio tools',
    dailyTokens: DEFAULT_PLAN_LIMITS.free.daily,
    monthlyTokens: DEFAULT_PLAN_LIMITS.free.monthly,
  },
  {
    id: 'pro',
    mappedPlan: 'premium' as PlanTier,
    name: 'Pro',
    priceUsdMonthly: 15,
    audience: 'Higher daily & per-model budgets, LOODY Kore code review, deep research & agents',
    dailyTokens: 250_000,
    monthlyTokens: 4_000_000,
  },
  {
    id: 'max',
    mappedPlan: 'premium' as PlanTier,
    name: 'Max',
    priceUsdMonthly: 40,
    audience: 'Maximum parallel orchestration, extended RAG & creative timelines',
    dailyTokens: 750_000,
    monthlyTokens: 12_000_000,
  },
] as const;

export function clampDailyQuota(requestedLimit: number): number {
  if (!Number.isFinite(requestedLimit) || requestedLimit < 0) return 0;
  return Math.min(Math.floor(requestedLimit), MAX_CONFIGURABLE_DAILY_TOKENS);
}

export function canAccessModel(
  user: { role: UserRole; plan: PlanTier },
  model: Pick<BrandedModel, 'requiredPlan'>
): { allowed: boolean; reason?: string } {
  // Developer/Admin privileges bypass subscription tier gates server-side
  if (user.role === 'developer' || user.role === 'admin') {
    return { allowed: true };
  }
  if (model.requiredPlan === 'free') {
    return { allowed: true };
  }
  if (user.plan === 'premium' || user.plan === 'developer') {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: 'This model requires an active Premium subscription or Developer role.',
  };
}

export function checkQuotaAllowance(params: {
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  modelId?: string;
  modelDailyUsed?: number;
  modelDailyLimit?: number;
  estimatedRequestTokens?: number;
}): {
  allowed: boolean;
  warningThreshold: boolean;
  reason?: string;
  dailyRemaining: number;
  monthlyRemaining: number;
  modelDailyRemaining?: number;
} {
  const projected = params.estimatedRequestTokens ?? 0;
  const dailyRemaining = Math.max(0, params.dailyLimit - params.dailyUsed);
  const monthlyRemaining = Math.max(0, params.monthlyLimit - params.monthlyUsed);
  const modelDailyRemaining =
    typeof params.modelDailyLimit === 'number' && typeof params.modelDailyUsed === 'number'
      ? Math.max(0, params.modelDailyLimit - params.modelDailyUsed)
      : undefined;

  if (params.dailyUsed >= params.dailyLimit || params.dailyUsed + projected > params.dailyLimit) {
    return {
      allowed: false,
      warningThreshold: true,
      dailyRemaining,
      monthlyRemaining,
      modelDailyRemaining,
      reason: `Daily token quota reached (${params.dailyUsed.toLocaleString()} / ${params.dailyLimit.toLocaleString()}). Resets daily at 00:00 UTC.`,
    };
  }
  if (params.monthlyUsed >= params.monthlyLimit || params.monthlyUsed + projected > params.monthlyLimit) {
    return {
      allowed: false,
      warningThreshold: true,
      dailyRemaining,
      monthlyRemaining,
      modelDailyRemaining,
      reason: `Monthly token quota reached (${params.monthlyUsed.toLocaleString()} / ${params.monthlyLimit.toLocaleString()}). Resets on the 1st of next month at 00:00 UTC.`,
    };
  }
  if (
    typeof params.modelDailyLimit === 'number' &&
    typeof params.modelDailyUsed === 'number' &&
    (params.modelDailyUsed >= params.modelDailyLimit ||
      params.modelDailyUsed + projected > params.modelDailyLimit)
  ) {
    const label = params.modelId ?? 'this model';
    return {
      allowed: false,
      warningThreshold: true,
      dailyRemaining,
      monthlyRemaining,
      modelDailyRemaining,
      reason: `Daily quota reached for ${label} (${params.modelDailyUsed.toLocaleString()} / ${params.modelDailyLimit.toLocaleString()} tokens). Switch to another model or wait until 00:00 UTC reset.`,
    };
  }
  const ratio = params.dailyLimit > 0 ? params.dailyUsed / params.dailyLimit : 1;
  const modelRatio =
    typeof params.modelDailyLimit === 'number' && params.modelDailyLimit > 0 && typeof params.modelDailyUsed === 'number'
      ? params.modelDailyUsed / params.modelDailyLimit
      : 0;
  return {
    allowed: true,
    warningThreshold: ratio >= 0.8 || modelRatio >= 0.8,
    dailyRemaining,
    monthlyRemaining,
    modelDailyRemaining,
  };
}

export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function computeEstimatedCostUsd(params: {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}): number {
  // Reference blended rates in USD per 1M tokens for transparent estimation
  const rates: Record<string, { inPerM: number; outPerM: number; cachedPerM: number }> = {
    gemini: { inPerM: 0.15, outPerM: 0.60, cachedPerM: 0.0375 },
    'openai-compatible': { inPerM: 2.00, outPerM: 8.00, cachedPerM: 0.50 },
    'anthropic-compatible': { inPerM: 3.00, outPerM: 15.0, cachedPerM: 0.30 },
    'hosted-oss': { inPerM: 0.20, outPerM: 0.40, cachedPerM: 0.05 },
    mistral: { inPerM: 0.40, outPerM: 1.20, cachedPerM: 0.20 },
    cohere: { inPerM: 2.50, outPerM: 10.0, cachedPerM: 1.25 },
    xai: { inPerM: 3.00, outPerM: 15.0, cachedPerM: 0.75 },
    ai21: { inPerM: 0.50, outPerM: 1.50, cachedPerM: 0.25 },
    groq: { inPerM: 0.15, outPerM: 0.30, cachedPerM: 0.075 },
    cerebras: { inPerM: 0.10, outPerM: 0.10, cachedPerM: 0.05 },
    sambanova: { inPerM: 0.40, outPerM: 0.80, cachedPerM: 0.20 },
    together: { inPerM: 0.60, outPerM: 0.90, cachedPerM: 0.30 },
    fireworks: { inPerM: 0.50, outPerM: 0.90, cachedPerM: 0.25 },
    'github-models': { inPerM: 0.00, outPerM: 0.00, cachedPerM: 0.00 },
    huggingface: { inPerM: 0.25, outPerM: 0.60, cachedPerM: 0.12 },
    cloudflare: { inPerM: 0.25, outPerM: 0.75, cachedPerM: 0.12 },
    nvidia: { inPerM: 0.30, outPerM: 0.80, cachedPerM: 0.15 },
    deepinfra: { inPerM: 0.35, outPerM: 0.60, cachedPerM: 0.17 },
    openrouter: { inPerM: 1.50, outPerM: 5.00, cachedPerM: 0.75 },
  };
  const r = rates[params.provider] ?? rates.gemini;
  const cached = Math.max(0, params.cachedTokens ?? 0);
  const nonCachedIn = Math.max(0, params.inputTokens - cached);
  const total =
    (nonCachedIn / 1_000_000) * r.inPerM +
    (cached / 1_000_000) * r.cachedPerM +
    (Math.max(0, params.outputTokens) / 1_000_000) * r.outPerM;
  return Number(total.toFixed(6));
}

export function reconcileTokenRecord(params: {
  providerReported?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedTokens?: number | null;
  };
  fallbackInputText: string;
  fallbackOutputText: string;
}): {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  accountingType: 'provider_reported' | 'estimated';
} {
  const repIn = params.providerReported?.inputTokens;
  const repOut = params.providerReported?.outputTokens;
  if (typeof repIn === 'number' && repIn >= 0 && typeof repOut === 'number' && repOut >= 0) {
    return {
      inputTokens: repIn,
      outputTokens: repOut,
      cachedTokens: Math.max(0, params.providerReported?.cachedTokens ?? 0),
      accountingType: 'provider_reported',
    };
  }
  return {
    inputTokens: estimateTextTokens(params.fallbackInputText),
    outputTokens: estimateTextTokens(params.fallbackOutputText),
    cachedTokens: 0,
    accountingType: 'estimated',
  };
}
