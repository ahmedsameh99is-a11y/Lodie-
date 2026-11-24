import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLoodyIdentityDirective,
  CircuitBreakerRegistry,
  DeterministicResponseCache,
  detectPromptLanguage,
  executeWithMultiProviderFallback,
  planProviderRoutes,
  trimMessagesForContextBudget,
  type ProviderRuntimeAvailability,
} from './multiProviderOrchestrator';
import { getCompatibilityRoutesForModel } from './providerMatrix';

function makeAvailability(enabledProviders: string[]): Record<string, ProviderRuntimeAvailability> {
  const all = [
    'gemini', 'mistral', 'cohere', 'xai', 'ai21', 'groq', 'cerebras', 'sambanova',
    'together', 'fireworks', 'github-models', 'huggingface', 'cloudflare', 'nvidia',
    'deepinfra', 'openai-compatible', 'anthropic-compatible', 'hosted-oss', 'openrouter',
  ];
  const out: Record<string, ProviderRuntimeAvailability> = {};
  for (const p of all) {
    out[p] = {
      configured: enabledProviders.includes(p),
      retired: p === 'github-models',
      todaySpendUsd: 0,
      dailyBudgetUsd: 20,
      todayRequests: 0,
      dailyRequestCap: 1000,
    };
  }
  return out;
}

test('CircuitBreakerRegistry opens on consecutive failures, cools down to half_open, and recovers on success', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 5_000 });
  const t0 = 1_000_000;

  assert.equal(cb.canAttempt('groq', t0).allowed, true);
  cb.recordFailure('groq', 'provider_unavailable', '503', t0);
  cb.recordFailure('groq', 'rate_limit', '429', t0 + 100);
  assert.equal(cb.canAttempt('groq', t0 + 200).state, 'closed');

  // 3rd failure opens circuit
  cb.recordFailure('groq', 'latency', '504', t0 + 300);
  assert.equal(cb.canAttempt('groq', t0 + 400).allowed, false);
  assert.equal(cb.canAttempt('groq', t0 + 400).state, 'open');

  // After cooldown passes, transitions to half_open probe
  const probeCheck = cb.canAttempt('groq', t0 + 6_000);
  assert.equal(probeCheck.allowed, true);
  assert.equal(probeCheck.state, 'half_open');

  // Successful response closes circuit and records latency
  cb.recordSuccess('groq', 320, t0 + 6_100);
  const closed = cb.canAttempt('groq', t0 + 6_200);
  assert.equal(closed.allowed, true);
  assert.equal(closed.state, 'closed');
  assert.equal(cb.get('groq').consecutiveFailures, 0);
  assert.equal(cb.get('groq').avgLatencyMs, 320);

  // Immediate open on auth_error
  cb.recordFailure('mistral', 'auth_error', '401 invalid key', t0);
  assert.equal(cb.canAttempt('mistral', t0 + 10).allowed, false);
});

test('planProviderRoutes filters by context ceiling, vision modality, budgets, and circuit state', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 10_000 });
  const avail = makeAvailability(['cloudflare', 'groq', 'gemini', 'mistral']);
  // Exhaust daily budget on mistral
  avail.mistral.todaySpendUsd = avail.mistral.dailyBudgetUsd;

  // 25,000 input tokens must skip Cloudflare's 24,000 limit cleanly
  const largePlan = planProviderRoutes({
    brandedModelId: 'sonic-3',
    routes: getCompatibilityRoutesForModel('sonic-3'),
    providerStatus: avail,
    circuitBreaker: cb,
    hasImageAttachments: false,
    requiresStreaming: true,
    estimatedInputTokens: 25_000,
    intentMode: 'fast',
    promptLanguage: 'en',
  });

  assert.equal(largePlan.candidates.some((c) => c.route.provider === 'cloudflare'), false);
  assert.equal(largePlan.candidates.some((c) => c.route.provider === 'mistral'), false);
  assert.ok(largePlan.skipped.some((s) => s.provider === 'cloudflare' && s.reason.includes('context headroom')));
  assert.ok(largePlan.skipped.some((s) => s.provider === 'mistral' && s.reason.includes('budget')));
  assert.ok(largePlan.candidates.some((c) => c.route.provider === 'gemini'));
  assert.ok(largePlan.candidates.some((c) => c.route.provider === 'groq'));

  // Vision check skips text-only routes cleanly
  const visionPlan = planProviderRoutes({
    brandedModelId: 'loody-vision-1',
    routes: getCompatibilityRoutesForModel('loody-vision-1'),
    providerStatus: makeAvailability(['gemini', 'groq', 'cohere', 'mistral']),
    circuitBreaker: cb,
    hasImageAttachments: true,
    requiresStreaming: true,
    estimatedInputTokens: 500,
    intentMode: 'analysis',
    promptLanguage: detectPromptLanguage('حلل هذه الصورة من فضلك'),
  });
  assert.equal(detectPromptLanguage('حلل هذه الصورة من فضلك'), 'ar');
  assert.ok(visionPlan.candidates.length >= 3);
  assert.equal(visionPlan.candidates.every((c) => c.route.supportsVision), true);
});

test('trimMessagesForContextBudget preserves latest user prompt and drops oldest history', () => {
  const msgs = [
    { role: 'user' as const, content: 'A'.repeat(4000) },
    { role: 'assistant' as const, content: 'B'.repeat(4000) },
    { role: 'user' as const, content: 'Latest important question' },
  ];
  const trimmed = trimMessagesForContextBudget(msgs, 200, 1_500);
  assert.ok(trimmed.trimmedTurns >= 1);
  assert.equal(trimmed.messages[trimmed.messages.length - 1].content, 'Latest important question');
});

test('executeWithMultiProviderFallback fails over transparently, respects AbortSignal, and caps retries', async () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 2, cooldownMs: 5_000 });
  const avail = makeAvailability(['gemini', 'groq', 'mistral']);
  const plan = planProviderRoutes({
    brandedModelId: 'sonic-3',
    routes: getCompatibilityRoutesForModel('sonic-3'),
    providerStatus: avail,
    circuitBreaker: cb,
    hasImageAttachments: false,
    requiresStreaming: true,
    estimatedInputTokens: 100,
    intentMode: 'fast',
    promptLanguage: 'en',
  });

  // First candidate fails with 429 rate_limit, second returns empty, third succeeds
  let calls = 0;
  const result = await executeWithMultiProviderFallback({
    candidates: plan.candidates,
    circuitBreaker: cb,
    maxRetries: 3,
    invoke: async (cand) => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('429 Rate limit reached'), { errorClass: 'rate_limit', retryable: true });
      }
      if (calls === 2) {
        return { emittedAnyChunk: false, latencyMs: 50 };
      }
      assert.ok(cand.route.provider);
      return { emittedAnyChunk: true, latencyMs: 120 };
    },
    extractErrorMeta: (err) => ({
      errorClass: ((err as { errorClass?: string }).errorClass as 'rate_limit') ?? 'provider_unavailable',
      retryable: true,
      message: (err as Error).message,
    }),
  });

  assert.equal(calls, 3);
  assert.equal(result.fallbackOccurred, true);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[2].ok, true);

  // Abort stops immediately without fallback attempts
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    executeWithMultiProviderFallback({
      candidates: plan.candidates,
      circuitBreaker: cb,
      signal: ac.signal,
      invoke: async () => ({ emittedAnyChunk: true }),
      extractErrorMeta: () => ({ errorClass: 'provider_unavailable', retryable: true, message: 'err' }),
    }),
    (err: unknown) => (err as { name?: string })?.name === 'AbortError'
  );
});

test('DeterministicResponseCache enforces TTL expiry cleanly', () => {
  const cache = new DeterministicResponseCache({ maxEntries: 10, ttlMs: 1_000 });
  cache.set(
    'k1',
    { text: 'OK', inputTokens: 5, outputTokens: 1, provider: 'gemini', upstreamModelId: 'gemini-3.1-flash-lite' },
    10_000
  );
  assert.equal(cache.get('k1', 10_500)?.text, 'OK');
  assert.equal(cache.get('k1', 11_100), null);
});

test('CircuitBreakerRegistry honors Retry-After cooldown on rate_limit and buildLoodyIdentityDirective enforces persona policy', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 5_000 });
  const t0 = 2_000_000;
  cb.recordFailure('groq', 'rate_limit', '429 slow down', t0, 12_000);
  assert.equal(cb.canAttempt('groq', t0 + 1_000).allowed, false);
  assert.equal(cb.canAttempt('groq', t0 + 11_500).allowed, false);
  assert.equal(cb.canAttempt('groq', t0 + 12_500).state, 'half_open');

  const directive = buildLoodyIdentityDirective({
    modelDisplayName: 'LOODY 5.5',
    upstreamProvider: 'gemini',
    upstreamModelId: 'gemini-3.6-flash',
  });
  assert.match(directive, /I’m LOODY, your AI workspace assistant\. I’m currently operating through LOODY 5\.5\./);
  assert.match(directive, /أعمل حالياً عبر LOODY 5\.5\./);
  assert.match(directive, /provider "gemini", model "gemini-3\.6-flash"/);
  assert.match(directive, /Do NOT claim that LOODY owns or independently trained/);
});

test('Controlled mocked orchestrator load benchmark at concurrency 1, 2, and 5 verifies median/p95/success cleanly', async () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 5_000 });
  const avail = makeAvailability(['groq', 'gemini']);
  const plan = planProviderRoutes({
    brandedModelId: 'sonic-3',
    routes: getCompatibilityRoutesForModel('sonic-3'),
    providerStatus: avail,
    circuitBreaker: cb,
    hasImageAttachments: false,
    requiresStreaming: true,
    estimatedInputTokens: 100,
    intentMode: 'fast',
    promptLanguage: 'en',
  });

  const percentile = (sorted: number[], p: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };

  for (const concurrency of [1, 2, 5]) {
    const latencies: number[] = [];
    let okCount = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async (_, i) => {
        const res = await executeWithMultiProviderFallback({
          candidates: plan.candidates,
          circuitBreaker: cb,
          maxRetries: 2,
          invoke: async () => {
            const simMs = 8 + i * 3;
            await new Promise((r) => setTimeout(r, simMs));
            return { emittedAnyChunk: true, latencyMs: simMs };
          },
          extractErrorMeta: () => ({ errorClass: 'provider_unavailable', retryable: true, message: 'err' }),
        });
        if (res.selectedCandidate) {
          okCount++;
          latencies.push(res.attempts[res.attempts.length - 1].latencyMs);
        }
      })
    );
    latencies.sort((a, b) => a - b);
    assert.equal(okCount, concurrency);
    assert.ok(percentile(latencies, 50) >= 8);
    assert.ok(percentile(latencies, 95) >= percentile(latencies, 50));
  }
});

test('planProviderRoutes ranks proven working slow Gemini backup ahead of zero-success failing NVIDIA endpoint', () => {
  const cb = new CircuitBreakerRegistry({ failureThreshold: 4, cooldownMs: 5_000 });
  const t0 = 3_000_000;
  // Gemini has succeeded cleanly before with 9s average latency
  cb.recordSuccess('gemini', 9_000, t0);
  // NVIDIA only ever failed (401 auth_error), then cooled down into half_open
  cb.recordFailure('nvidia', 'auth_error', '401 Unauthorized access', t0);
  const avail = makeAvailability(['gemini', 'nvidia']);

  const plan = planProviderRoutes({
    brandedModelId: 'loody-vision-1',
    routes: getCompatibilityRoutesForModel('loody-vision-1'),
    providerStatus: avail,
    circuitBreaker: cb,
    hasImageAttachments: true,
    requiresStreaming: true,
    estimatedInputTokens: 600,
    intentMode: 'fast',
    promptLanguage: 'en',
    nowMs: t0 + 30_000, // nvidia is now half_open
  });

  const geminiBackupIdx = plan.candidates.findIndex(
    (c) => c.route.provider === 'gemini' && c.route.upstreamModelId === 'gemini-3.6-flash'
  );
  const nvidiaIdx = plan.candidates.findIndex((c) => c.route.provider === 'nvidia');
  assert.ok(geminiBackupIdx >= 0);
  assert.ok(nvidiaIdx > geminiBackupIdx, 'healthy gemini backup must outrank zero-success failing nvidia');
});

