import { canAccessModel } from './quotas';
import type { AvailabilityStatus, BrandedModel, PlanTier, UserRole } from './types';

export const REQUIRED_BRANDED_MODEL_IDS = [
  'sonic-3',
  'sonic-3.5',
  'lodie-5.5',
  'fables-5.3',
  'loody-vision-1',
] as const;

const CALLABLE_STATES = new Set<AvailabilityStatus>(['operational', 'connected', 'slow']);
const CONFIG_BLOCKED_STATES = new Set<AvailabilityStatus>([
  'awaiting_config',
  'configuration_error',
  'authentication_error',
  'disabled',
]);

export interface ModelStatusMeta {
  configured: boolean;
  connectivityTested: boolean;
  operational: boolean;
  callable: boolean;
  temporarilyUnavailable: boolean;
  awaitingConfiguration: boolean;
  authError: boolean;
  disabled: boolean;
  badgeLabel: string;
  shortLabel: string;
}

export function getModelStatusMeta(
  model: Pick<BrandedModel, 'availability' | 'speedClass' | 'lastTestedAt'>
): ModelStatusMeta {
  const av = model.availability;
  const configured = !CONFIG_BLOCKED_STATES.has(av);
  const connectivityTested = Boolean(model.lastTestedAt);
  const operational = av === 'operational' || av === 'slow';
  const callable = CALLABLE_STATES.has(av);
  const temporarilyUnavailable = av === 'temporarily_unavailable' || av === 'error';
  const awaitingConfiguration = av === 'awaiting_config' || av === 'configuration_error';
  const authError = av === 'authentication_error';
  const disabled = av === 'disabled';

  const badgeLabels: Record<AvailabilityStatus, string> = {
    operational: 'Operational',
    connected: 'Configured (Untested)',
    slow: 'Slow',
    temporarily_unavailable: 'Temporarily Unavailable',
    configuration_error: 'Config Error',
    authentication_error: 'Auth Error',
    awaiting_config: 'Awaiting Config',
    disabled: 'Disabled',
    error: 'Provider Error',
  };

  const shortLabels: Record<AvailabilityStatus, string> = {
    operational: model.speedClass,
    connected: 'Configured · Untested',
    slow: 'Slow',
    temporarily_unavailable: 'Temporarily Unavailable',
    configuration_error: 'Config Error',
    authentication_error: 'Auth Error',
    awaiting_config: 'Awaiting Config',
    disabled: 'Disabled',
    error: 'Unavailable',
  };

  return {
    configured,
    connectivityTested,
    operational,
    callable,
    temporarilyUnavailable,
    awaitingConfiguration,
    authError,
    disabled,
    badgeLabel: badgeLabels[av] ?? av,
    shortLabel: shortLabels[av] ?? av,
  };
}

export function sortBrandedModels(models: BrandedModel[]): BrandedModel[] {
  const order: readonly string[] = REQUIRED_BRANDED_MODEL_IDS;
  return [...models].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    const rankA = ia === -1 ? order.length : ia;
    const rankB = ib === -1 ? order.length : ib;
    return rankA - rankB || a.id.localeCompare(b.id);
  });
}

export function validateModelCompatibility(params: {
  model: BrandedModel;
  hasImageAttachments: boolean;
  requiresStreaming: boolean;
}): { compatible: boolean; reason?: string } {
  if (params.hasImageAttachments && !params.model.inputModalities.includes('image')) {
    return {
      compatible: false,
      reason: `${params.model.displayName} does not support image attachments. Switch to LOODY Vision 1 or another multimodal model.`,
    };
  }
  if (params.requiresStreaming && !params.model.supportsStreaming) {
    return {
      compatible: false,
      reason: `${params.model.displayName} does not support streaming responses.`,
    };
  }
  if (!CALLABLE_STATES.has(params.model.availability)) {
    return {
      compatible: false,
      reason: `${params.model.displayName} is currently unavailable (${params.model.availabilityReason}).`,
    };
  }
  return { compatible: true };
}

export function selectFallbackCandidate(params: {
  failedModel: BrandedModel;
  allModels: BrandedModel[];
  user: { role: UserRole; plan: PlanTier };
  hasImageAttachments: boolean;
  requiresStreaming: boolean;
}): BrandedModel | null {
  const healthRank = (av: AvailabilityStatus): number => {
    if (av === 'operational') return 0;
    if (av === 'connected') return 1;
    if (av === 'slow') return 2;
    return 99;
  };

  const candidates = sortBrandedModels(params.allModels)
    .filter((cand) => {
      if (cand.id === params.failedModel.id) return false;
      // Never retry the exact same failing upstream provider/model alias
      if (
        cand.provider === params.failedModel.provider &&
        cand.upstreamModelId === params.failedModel.upstreamModelId
      ) {
        return false;
      }
      if (!canAccessModel(params.user, cand).allowed) return false;
      return validateModelCompatibility({
        model: cand,
        hasImageAttachments: params.hasImageAttachments,
        requiresStreaming: params.requiresStreaming,
      }).compatible;
    })
    .sort((a, b) => {
      const rankDiff = healthRank(a.availability) - healthRank(b.availability);
      if (rankDiff !== 0) return rankDiff;
      const latA = typeof a.avgLatencyMs === 'number' && a.avgLatencyMs > 0 ? a.avgLatencyMs : Number.MAX_SAFE_INTEGER;
      const latB = typeof b.avgLatencyMs === 'number' && b.avgLatencyMs > 0 ? b.avgLatencyMs : Number.MAX_SAFE_INTEGER;
      return latA - latB;
    });

  return candidates[0] ?? null;
}

export function isValidBrandedLineup(models: BrandedModel[]): boolean {
  const ids = new Set(models.map((m) => m.id));
  return REQUIRED_BRANDED_MODEL_IDS.every((req) => ids.has(req));
}
