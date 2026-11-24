import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_BRANDED_MODEL_IDS } from './modelRegistry';
import { CircuitBreakerRegistry, planProviderRoutes } from './multiProviderOrchestrator';
import {
  getAllMatrixRoutes,
  getCompatibilityRoutesForModel,
  MATRIX_UNSUPPORTED_NOTES,
  MODEL_COMPATIBILITY_MATRIX,
} from './providerMatrix';

test('compatibility matrix covers all 5 branded LOODY models with <=10 verified routes each', () => {
  for (const modelId of REQUIRED_BRANDED_MODEL_IDS) {
    const routes = getCompatibilityRoutesForModel(modelId);
    assert.ok(routes.length >= 9 && routes.length <= 10, `${modelId} has unexpected route count: ${routes.length}`);
    // Unique provider+upstream pairs per model
    const keys = new Set(routes.map((r) => `${r.provider}::${r.upstreamModelId}`));
    assert.equal(keys.size, routes.length, `Duplicate route detected in ${modelId}`);
    // Universal multimodal parity: every branded model has at least 1 vision-capable route
    assert.ok(
      routes.some((r) => r.supportsVision),
      `${modelId} must have at least one vision-capable route`
    );
  }
  assert.equal(Object.keys(MODEL_COMPATIBILITY_MATRIX).length, 5);
});

test('compatibility matrix never assigns retired github-models or routes images to text-only groq primary', () => {
  const all = getAllMatrixRoutes();
  assert.equal(
    all.some((r) => r.provider === 'github-models'),
    false,
    'Retired github-models must not appear in active routes'
  );

  const visionRoutes = getCompatibilityRoutesForModel('loody-vision-1');
  for (const route of visionRoutes) {
    assert.equal(route.supportsVision, true, `Non-vision route ${route.id} found in loody-vision-1`);
    assert.notEqual(route.provider, 'groq', 'Groq text-only catalog must not appear in loody-vision-1');
  }

  // When sonic-3 or fables-5.3 has groq as fast text primary and an image is attached, planner must skip groq & pick vision routes
  for (const modelId of ['sonic-3', 'fables-5.3'] as const) {
    const routes = getCompatibilityRoutesForModel(modelId);
    const plan = planProviderRoutes({
      brandedModelId: modelId,
      routes,
      registryPrimary: {
        provider: 'groq',
        upstreamModelId: modelId === 'sonic-3' ? 'openai/gpt-oss-20b' : 'openai/gpt-oss-120b',
        contextLimit: 131_072,
        supportsVision: true, // Even if a caller passed stale flag, orchestrator overrides text-only groq to false
        supportsStreaming: true,
        supportsTools: true,
      },
      providerStatus: {
        groq: { configured: true, retired: false, dailyBudgetUsd: 1, todaySpendUsd: 0, dailyRequestCap: 100, todayRequests: 0 },
        gemini: { configured: true, retired: false, dailyBudgetUsd: 1, todaySpendUsd: 0, dailyRequestCap: 100, todayRequests: 0 },
      },
      circuitBreaker: new CircuitBreakerRegistry(),
      hasImageAttachments: true,
      requiresStreaming: true,
      estimatedInputTokens: 200,
      intentMode: 'auto',
      promptLanguage: 'en',
    });
    assert.ok(plan.candidates.length >= 1, `${modelId} must resolve a Gemini vision candidate for images`);
    assert.equal(plan.candidates.some((c) => c.route.provider === 'groq'), false);
    assert.equal(plan.candidates[0].route.provider, 'gemini');
  }

  // Cloudflare Llama 3.3 must keep exact 24K limit
  const cfFast = getCompatibilityRoutesForModel('sonic-3').find((r) => r.provider === 'cloudflare');
  assert.ok(cfFast);
  assert.equal(cfFast.contextLimit, 24_000);

  // Explicit unsupported/excluded documentation exists
  assert.ok(MATRIX_UNSUPPORTED_NOTES.some((n) => n.provider === 'github-models'));
  assert.ok(MATRIX_UNSUPPORTED_NOTES.some((n) => n.provider === 'cohere'));
  assert.ok(MATRIX_UNSUPPORTED_NOTES.some((n) => n.provider === 'groq'));
});
