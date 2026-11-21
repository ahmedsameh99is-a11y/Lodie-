import type { BrandedModel, PlanTier, UserRole } from './types';

export const MAX_CONFIGURABLE_DAILY_TOKENS = 1_000_000;

export const DEFAULT_PLAN_LIMITS: Record<PlanTier, { daily: number; monthly: number }> = {
  free: { daily: 25_000, monthly: 300_000 },
  premium: { daily: 250_000, monthly: 4_000_000 },
  developer: { daily: MAX_CONFIGURABLE_DAILY_TOKENS, monthly: 15_000_000 },
};

export const COMMERCIAL_PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceUsdMonthly: 0,
    audience: 'Everyday fast chat, uploads, and entry workspace tools',
    dailyTokens: DEFAULT_PLAN_LIMITS.free.daily,
    monthlyTokens: DEFAULT_PLAN_LIMITS.free.monthly,
  },
  {
    id: 'pro',
    mappedPlan: 'premium' as PlanTier,
    name: 'Pro',
    priceUsdMonthly: 15,
    audience: 'Deep reasoning, LOODY Kore code review, research & agents',
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
  estimatedRequestTokens?: number;
}): { allowed: boolean; warningThreshold: boolean; reason?: string } {
  const projected = params.estimatedRequestTokens ?? 0;
  if (params.dailyUsed >= params.dailyLimit || params.dailyUsed + projected > params.dailyLimit) {
    return {
      allowed: false,
      warningThreshold: true,
      reason: `Daily token quota reached (${params.dailyUsed.toLocaleString()} / ${params.dailyLimit.toLocaleString()}).`,
    };
  }
  if (params.monthlyUsed >= params.monthlyLimit || params.monthlyUsed + projected > params.monthlyLimit) {
    return {
      allowed: false,
      warningThreshold: true,
      reason: `Monthly token quota reached (${params.monthlyUsed.toLocaleString()} / ${params.monthlyLimit.toLocaleString()}).`,
    };
  }
  const ratio = params.dailyLimit > 0 ? params.dailyUsed / params.dailyLimit : 1;
  return {
    allowed: true,
    warningThreshold: ratio >= 0.8,
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
    'openai-compatible': { inPerM: 2.50, outPerM: 10.0, cachedPerM: 1.25 },
    'anthropic-compatible': { inPerM: 3.00, outPerM: 15.0, cachedPerM: 0.30 },
    'hosted-oss': { inPerM: 0.20, outPerM: 0.40, cachedPerM: 0.05 },
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
