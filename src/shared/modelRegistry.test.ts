import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrandedModel } from './types';
import { isValidBrandedLineup, validateModelCompatibility } from './modelRegistry';

const textOnlyModel: BrandedModel = {
  id: 'sonic-3',
  displayName: 'Sonic 3',
  tier: 'free',
  requiredPlan: 'free',
  provider: 'gemini',
  upstreamModelId: 'gemini-3.1-flash-lite',
  description: 'Fast model',
  speedClass: 'Ultra-Fast',
  reasoningLevel: 'Standard',
  contextLimit: 1000000,
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsStreaming: true,
  pricingSummary: 'Free Tier',
  availability: 'operational',
  availabilityReason: 'Configured',
  lastTestedAt: null,
};

const visionModel: BrandedModel = {
  ...textOnlyModel,
  id: 'loody-vision-1',
  displayName: 'LOODY Vision 1',
  tier: 'multimodal',
  inputModalities: ['text', 'image'],
};

const unconfiguredModel: BrandedModel = {
  ...textOnlyModel,
  id: 'fables-5.3',
  displayName: 'Fables 5.3',
  tier: 'premium',
  requiredPlan: 'premium',
  provider: 'openai-compatible',
  availability: 'awaiting_config',
  availabilityReason: 'Awaiting provider API key',
};

test('validateModelCompatibility blocks images on text-only models and unconfigured models', () => {
  assert.equal(
    validateModelCompatibility({
      model: textOnlyModel,
      hasImageAttachments: true,
      requiresStreaming: true,
    }).compatible,
    false
  );
  assert.equal(
    validateModelCompatibility({
      model: visionModel,
      hasImageAttachments: true,
      requiresStreaming: true,
    }).compatible,
    true
  );
  assert.equal(
    validateModelCompatibility({
      model: unconfiguredModel,
      hasImageAttachments: false,
      requiresStreaming: true,
    }).compatible,
    false
  );
});

test('isValidBrandedLineup verifies all 5 required LOODY branded models', () => {
  assert.equal(isValidBrandedLineup([textOnlyModel, visionModel]), false);
  const full = [
    textOnlyModel,
    { ...textOnlyModel, id: 'sonic-3.5', displayName: 'Sonic 3.5' },
    { ...textOnlyModel, id: 'lodie-5.5', displayName: 'Lodie 5.5' },
    unconfiguredModel,
    visionModel,
  ];
  assert.equal(isValidBrandedLineup(full), true);
});
