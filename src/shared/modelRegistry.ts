import type { BrandedModel } from './types';

export const REQUIRED_BRANDED_MODEL_IDS = [
  'sonic-3',
  'sonic-3.5',
  'lodie-5.5',
  'fables-5.3',
  'loody-vision-1',
] as const;

const CALLABLE_STATES = new Set(['operational', 'connected', 'slow']);

export function validateModelCompatibility(params: {
  model: BrandedModel;
  hasImageAttachments: boolean;
  requiresStreaming: boolean;
}): { compatible: boolean; reason?: string } {
  if (!CALLABLE_STATES.has(params.model.availability)) {
    return {
      compatible: false,
      reason: `${params.model.displayName} is currently unavailable (${params.model.availabilityReason}).`,
    };
  }
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
  return { compatible: true };
}

export function isValidBrandedLineup(models: BrandedModel[]): boolean {
  const ids = new Set(models.map((m) => m.id));
  return REQUIRED_BRANDED_MODEL_IDS.every((req) => ids.has(req));
}
