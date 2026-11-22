import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrandedModel } from './types';
import {
  getModelStatusMeta,
  isValidBrandedLineup,
  selectFallbackCandidate,
  sortBrandedModels,
  validateModelCompatibility,
} from './modelRegistry';

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
  availabilityReason: 'Verified live',
  lastTestedAt: '2026-11-21T00:00:00.000Z',
  avgLatencyMs: 900,
};

const visionModel: BrandedModel = {
  ...textOnlyModel,
  id: 'loody-vision-1',
  displayName: 'LOODY Vision 1',
  tier: 'multimodal',
  upstreamModelId: 'gemini-4-hydrogen',
  inputModalities: ['text', 'image'],
};

const unconfiguredModel: BrandedModel = {
  ...textOnlyModel,
  id: 'fables-5.3',
  displayName: 'Fables 5.3',
  tier: 'premium',
  requiredPlan: 'premium',
  provider: 'openai-compatible',
  upstreamModelId: 'gpt-4.1',
  availability: 'awaiting_config',
  availabilityReason: 'Awaiting provider API key',
  lastTestedAt: null,
  avgLatencyMs: null,
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

test('getModelStatusMeta separates configured, connectivity tested, operational, unavailable, and awaiting config', () => {
  const op = getModelStatusMeta(textOnlyModel);
  assert.equal(op.configured, true);
  assert.equal(op.connectivityTested, true);
  assert.equal(op.operational, true);
  assert.equal(op.callable, true);
  assert.equal(op.badgeLabel, 'Operational');

  const untested = getModelStatusMeta({
    ...textOnlyModel,
    availability: 'connected',
    lastTestedAt: null,
  });
  assert.equal(untested.configured, true);
  assert.equal(untested.connectivityTested, false);
  assert.equal(untested.operational, false);
  assert.equal(untested.callable, true);
  assert.equal(untested.badgeLabel, 'Configured (Untested)');

  const unavailable = getModelStatusMeta({
    ...textOnlyModel,
    availability: 'temporarily_unavailable',
  });
  assert.equal(unavailable.configured, true);
  assert.equal(unavailable.operational, false);
  assert.equal(unavailable.callable, false);
  assert.equal(unavailable.temporarilyUnavailable, true);
  assert.equal(unavailable.shortLabel, 'Temporarily Unavailable');

  const awaiting = getModelStatusMeta(unconfiguredModel);
  assert.equal(awaiting.configured, false);
  assert.equal(awaiting.awaitingConfiguration, true);
  assert.equal(awaiting.callable, false);
});

test('selectFallbackCandidate skips same failed provider/model alias, unhealthy models, and respects modalities & plans', () => {
  const failedLodie: BrandedModel = {
    ...textOnlyModel,
    id: 'lodie-5.5',
    displayName: 'Lodie 5.5',
    tier: 'premium',
    requiredPlan: 'premium',
    provider: 'gemini',
    upstreamModelId: 'gemini-4-hydrogen',
    availability: 'operational',
  };
  const sameAliasSonic35: BrandedModel = {
    ...textOnlyModel,
    id: 'sonic-3.5',
    displayName: 'Sonic 3.5',
    provider: 'gemini',
    upstreamModelId: 'gemini-4-hydrogen',
    availability: 'operational',
    avgLatencyMs: 500,
  };
  const deadModel: BrandedModel = {
    ...textOnlyModel,
    id: 'fables-5.3',
    displayName: 'Fables 5.3',
    provider: 'openai-compatible',
    upstreamModelId: 'gpt-4.1',
    availability: 'temporarily_unavailable',
  };

  // Should skip sameAliasSonic35 (same gemini/gemini-4-hydrogen alias) and deadModel, picking sonic-3
  const picked = selectFallbackCandidate({
    failedModel: failedLodie,
    allModels: [sameAliasSonic35, deadModel, textOnlyModel],
    user: { role: 'user', plan: 'premium' },
    hasImageAttachments: false,
    requiresStreaming: true,
  });
  assert.equal(picked?.id, 'sonic-3');

  // When image attachments are present, text-only sonic-3 is excluded
  const pickedWithImage = selectFallbackCandidate({
    failedModel: failedLodie,
    allModels: [sameAliasSonic35, deadModel, textOnlyModel],
    user: { role: 'user', plan: 'premium' },
    hasImageAttachments: true,
    requiresStreaming: true,
  });
  assert.equal(pickedWithImage, null);

  // sortBrandedModels keeps canonical order
  const sorted = sortBrandedModels([visionModel, unconfiguredModel, textOnlyModel]);
  assert.deepEqual(
    sorted.map((m) => m.id),
    ['sonic-3', 'fables-5.3', 'loody-vision-1']
  );
});
