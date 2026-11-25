import type {
  BrandedModel,
  ErrorClass,
  MatrixRouteDescriptor,
  OrchestratorMode,
  ProviderId,
  ProviderStatusSummary,
} from '../src/shared/types';
import { buildUnifiedSystemInstruction } from '../src/shared/assistantPolicy';
import {
  CircuitBreakerRegistry,
  type CircuitRecord,
  DeterministicResponseCache,
  detectPromptLanguage,
  executeWithMultiProviderFallback,
  planProviderRoutes,
  type PlannedRouteCandidate,
  type ProviderRuntimeAvailability,
  trimMessagesForContextBudget,
} from '../src/shared/multiProviderOrchestrator';
import { getCompatibilityRoutesForModel, MODEL_COMPATIBILITY_MATRIX } from '../src/shared/providerMatrix';
import { estimateTextTokens } from '../src/shared/quotas';
import { db, getModelCredentials } from './db';
import {
  ProviderExecutionError,
  type ProviderMessage,
  type StreamCallbacks,
  streamModelResponse,
} from './providers';
import {
  ALL_PROVIDER_IDS,
  PROVIDER_CATALOG,
  resolveProviderCredentials,
} from './providers/catalog';

const circuitBreaker = new CircuitBreakerRegistry({
  failureThreshold: 4,
  cooldownMs: 20_000,
});

export const deterministicCache = new DeterministicResponseCache({
  maxEntries: 120,
  ttlMs: 300_000,
});

let rotationCounter = 0;

function hydrateCircuitBreakerFromDb() {
  try {
    const rows = db.prepare('SELECT * FROM provider_health').all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const provider = String(r.provider) as ProviderId;
      if (!(provider in PROVIDER_CATALOG)) continue;
      circuitBreaker.hydrate({
        provider,
        state: (String(r.circuit_state) as CircuitRecord['state']) || 'closed',
        consecutiveFailures: Number(r.consecutive_failures ?? 0),
        failureCount: Number(r.failure_count ?? 0),
        successCount: Number(r.success_count ?? 0),
        avgLatencyMs: r.avg_latency_ms !== null && r.avg_latency_ms !== undefined ? Number(r.avg_latency_ms) : null,
        lastErrorClass: r.last_error_class ? (String(r.last_error_class) as ErrorClass) : null,
        lastError: r.last_error ? String(r.last_error) : null,
        cooldownUntilMs: r.cooldown_until ? Date.parse(String(r.cooldown_until)) || null : null,
        lastCheckedAt: r.last_checked_at ? String(r.last_checked_at) : null,
      });
    }
  } catch {
    // Table may not exist yet during early boot/test init
  }
}

hydrateCircuitBreakerFromDb();

export function persistCircuitRecord(rec: CircuitRecord): void {
  const nowIso = new Date().toISOString();
  const cooldownIso = rec.cooldownUntilMs ? new Date(rec.cooldownUntilMs).toISOString() : null;
  db.prepare(`
    INSERT INTO provider_health (
      provider, circuit_state, consecutive_failures, failure_count, success_count,
      avg_latency_ms, last_error_class, last_error, cooldown_until, last_checked_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      circuit_state = excluded.circuit_state,
      consecutive_failures = excluded.consecutive_failures,
      failure_count = excluded.failure_count,
      success_count = excluded.success_count,
      avg_latency_ms = excluded.avg_latency_ms,
      last_error_class = excluded.last_error_class,
      last_error = excluded.last_error,
      cooldown_until = excluded.cooldown_until,
      last_checked_at = excluded.last_checked_at,
      updated_at = excluded.updated_at
  `).run(
    rec.provider,
    rec.state,
    rec.consecutiveFailures,
    rec.failureCount,
    rec.successCount,
    rec.avgLatencyMs,
    rec.lastErrorClass,
    rec.lastError,
    cooldownIso,
    rec.lastCheckedAt,
    nowIso
  );
}

export function getCircuitBreaker(): CircuitBreakerRegistry {
  return circuitBreaker;
}

export function resetProviderCircuit(provider: ProviderId): CircuitRecord {
  const next = circuitBreaker.reset(provider);
  persistCircuitRecord(next);
  return next;
}

export function getTodayProviderUsageMap(): Record<string, { requests: number; spendUsd: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(
      'SELECT provider, COUNT(*) as reqs, COALESCE(SUM(estimated_cost_usd), 0) as spend FROM token_usage WHERE usage_date = ? GROUP BY provider'
    )
    .all(today) as Array<{ provider: string; reqs: number; spend: number }>;

  const out: Record<string, { requests: number; spendUsd: number }> = {};
  for (const r of rows) {
    out[String(r.provider)] = {
      requests: Number(r.reqs ?? 0),
      spendUsd: Number(r.spend ?? 0),
    };
  }
  return out;
}

export function buildProviderSnapshots(params?: {
  overrideModelId?: string;
}): {
  runtimeAvailability: Record<string, ProviderRuntimeAvailability>;
  summaries: ProviderStatusSummary[];
} {
  const usageMap = getTodayProviderUsageMap();
  const storedCreds = params?.overrideModelId ? getModelCredentials(params.overrideModelId) : {};
  const runtimeAvailability: Record<string, ProviderRuntimeAvailability> = {};
  const summaries: ProviderStatusSummary[] = [];
  const nowMs = Date.now();

  for (const id of ALL_PROVIDER_IDS) {
    const entry = PROVIDER_CATALOG[id];
    const hasOverride = storedCreds.rowProvider === id;
    const creds = resolveProviderCredentials({
      provider: id,
      overrideApiKey: hasOverride ? storedCreds.apiKey : undefined,
      hasEncryptedKey: hasOverride && Boolean(storedCreds.apiKey),
      customBaseUrl: hasOverride ? storedCreds.baseUrl : undefined,
    });
    const circuitCheck = circuitBreaker.canAttempt(id, nowMs);
    const rec = circuitBreaker.get(id);
    const usage = usageMap[id] ?? { requests: 0, spendUsd: 0 };

    runtimeAvailability[id] = {
      configured: creds.configured,
      retired: creds.retired,
      todaySpendUsd: usage.spendUsd,
      dailyBudgetUsd: entry.dailyBudgetUsd,
      todayRequests: usage.requests,
      dailyRequestCap: entry.dailyRequestCap,
    };

    summaries.push({
      id,
      displayName: entry.displayName,
      protocol: entry.protocol,
      credentialStatus: creds.credentialStatus,
      configured: creds.configured,
      retired: creds.retired,
      retiredNotice: entry.retiredNotice,
      envVars: entry.envVars,
      defaultBaseUrl: entry.defaultBaseUrl,
      supportsVision: entry.supportsVision,
      supportsStreaming: entry.supportsStreaming,
      supportsTools: entry.supportsTools,
      supportsPromptCaching: entry.supportsPromptCaching,
      isGateway: entry.isGateway,
      circuitState: circuitCheck.state,
      consecutiveFailures: rec.consecutiveFailures,
      avgLatencyMs: rec.avgLatencyMs,
      lastErrorClass: rec.lastErrorClass,
      lastError: rec.lastError,
      cooldownUntil: rec.cooldownUntilMs ? new Date(rec.cooldownUntilMs).toISOString() : null,
      todaySpendUsd: Number(usage.spendUsd.toFixed(6)),
      todayRequests: usage.requests,
      dailyBudgetUsd: entry.dailyBudgetUsd,
      dailyRequestCap: entry.dailyRequestCap,
    });
  }

  return { runtimeAvailability, summaries };
}

export function hasAnyConfiguredRouteForModel(model: BrandedModel): boolean {
  const { runtimeAvailability } = buildProviderSnapshots({ overrideModelId: model.id });
  const primaryAvail = runtimeAvailability[model.provider];
  if (primaryAvail?.configured && !primaryAvail.retired) return true;
  const matrixRoutes = getCompatibilityRoutesForModel(model.id);
  return matrixRoutes.some((r) => {
    const a = runtimeAvailability[r.provider];
    return Boolean(a?.configured && !a.retired);
  });
}

export async function orchestrateChatStream(params: {
  model: BrandedModel;
  messages: ProviderMessage[];
  systemInstruction?: string;
  prompt: string;
  intentMode: OrchestratorMode;
  hasImageAttachments: boolean;
  allowFallback: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  callbacks: StreamCallbacks & {
    onAttemptStart?: (info: {
      route: MatrixRouteDescriptor;
      attemptIndex: number;
      fallbackOccurred: boolean;
      previousError?: string;
      previousErrorClass?: string;
    }) => void;
    onRouteSelected?: (info: {
      route: MatrixRouteDescriptor;
      fallbackOccurred: boolean;
      attemptCount: number;
    }) => void;
  };
}): Promise<{
  selectedRoute: MatrixRouteDescriptor;
  fallbackOccurred: boolean;
  attemptCount: number;
}> {
  const { runtimeAvailability } = buildProviderSnapshots({ overrideModelId: params.model.id });
  const routes = getCompatibilityRoutesForModel(params.model.id);
  const sysTokens = estimateTextTokens(params.systemInstruction ?? '');
  const msgTokens = params.messages.reduce((sum, m) => sum + estimateTextTokens(m.content), 0);
  const estimatedInputTokens = sysTokens + msgTokens + (params.hasImageAttachments ? 1_200 : 0);

  const seed = rotationCounter++;
  const plan = planProviderRoutes({
    brandedModelId: params.model.id,
    routes,
    registryPrimary: {
      provider: params.model.provider,
      upstreamModelId: params.model.upstreamModelId,
      contextLimit: params.model.contextLimit,
      supportsVision:
        params.model.inputModalities.includes('image') &&
        Boolean(PROVIDER_CATALOG[params.model.provider]?.supportsVision),
      supportsStreaming: params.model.supportsStreaming,
      supportsTools: params.model.supportsTools,
    },
    providerStatus: runtimeAvailability,
    circuitBreaker,
    hasImageAttachments: params.hasImageAttachments,
    requiresStreaming: true,
    estimatedInputTokens,
    intentMode: params.intentMode,
    promptLanguage: detectPromptLanguage(params.prompt),
    rotationSeed: seed,
  });

  if (plan.candidates.length === 0) {
    const hasCircuitOpen = plan.skipped.some((s) => s.reason.includes('Circuit breaker'));
    const hasContextSkip = plan.skipped.some((s) => s.reason.includes('context headroom'));
    const msg = hasContextSkip
      ? `${params.model.displayName} input exceeds the available configured providers' context limits.`
      : hasCircuitOpen
        ? `${params.model.displayName} upstream providers are temporarily in recovery cooldown. Please retry shortly.`
        : `${params.model.displayName} has no configured provider credentials available.`;

    throw new ProviderExecutionError(msg, {
      errorClass: hasCircuitOpen ? 'provider_unavailable' : 'configuration_error',
      healthStatus: hasCircuitOpen ? 'temporarily_unavailable' : 'awaiting_config',
      retryable: hasCircuitOpen,
    });
  }

  let selectedCandidate: PlannedRouteCandidate | null = null;

  const execResult = await executeWithMultiProviderFallback({
    candidates: plan.candidates,
    circuitBreaker,
    maxRetries: params.allowFallback ? Math.min(3, plan.candidates.length - 1) : 0,
    signal: params.signal,
    onAttemptStart: (info) => {
      selectedCandidate = info.candidate;
      params.callbacks.onAttemptStart?.({
        route: info.candidate.route,
        attemptIndex: info.attemptIndex,
        fallbackOccurred: info.fallbackOccurred,
        previousError: info.previousError,
        previousErrorClass: info.previousErrorClass,
      });
    },
    invoke: async (candidate) => {
      selectedCandidate = candidate;
      const fullSystemInstruction = buildUnifiedSystemInstruction({
        surface: 'chat',
        modelId: params.model.id,
        modelDisplayName: params.model.displayName,
        upstreamProvider: candidate.route.provider,
        upstreamModelId: candidate.route.upstreamModelId,
        orchestrationMode: params.intentMode === 'auto' ? undefined : params.intentMode,
        supplementalContext: params.systemInstruction,
      });

      const candidateSysTokens = estimateTextTokens(fullSystemInstruction);
      const tunedMessages = trimMessagesForContextBudget(
        params.messages,
        candidateSysTokens,
        candidate.route.contextLimit
      ).messages;

      const adaptiveThinking = (() => {
        if (params.intentMode === 'fast') {
          if (params.model.id === 'lodie-5.5') return 'LOW' as const;
          if (params.model.thinkingPreset === 'HIGH' || params.model.thinkingPreset === 'MEDIUM' || params.model.thinkingPreset === 'LOW') {
            return 'MINIMAL' as const;
          }
        }
        return params.model.thinkingPreset;
      })();

      const candidateModel: BrandedModel = {
        ...params.model,
        provider: candidate.route.provider,
        upstreamModelId: candidate.route.upstreamModelId,
        contextLimit: candidate.route.contextLimit,
        inputModalities: candidate.route.supportsVision ? ['text', 'image'] : ['text'],
        thinkingPreset: adaptiveThinking,
      };

      const candidateTimeoutMs =
        params.timeoutMs ??
        (candidate.route.provider === 'gemini'
          ? params.intentMode === 'deep_thinking' || params.model.id === 'lodie-5.5'
            ? 45_000
            : params.hasImageAttachments
              ? 38_000
              : 32_000
          : params.allowFallback
            ? 18_000
            : 25_000);

      let emittedAnyChunk = false;
      const start = Date.now();
      try {
        await streamModelResponse({
          model: candidateModel,
          messages: tunedMessages,
          systemInstruction: fullSystemInstruction,
          signal: params.signal,
          timeoutMs: candidateTimeoutMs,
          maxAttempts: 1,
          callbacks: {
            onFirstToken: params.callbacks.onFirstToken,
            onChunk: (chunk) => {
              if (chunk.length > 0) emittedAnyChunk = true;
              params.callbacks.onChunk(chunk);
            },
            onUsage: params.callbacks.onUsage,
            onProviderMeta: params.callbacks.onProviderMeta,
          },
        });
      } finally {
        // Persist updated circuit snapshot on completion or failure after executeWithMultiProviderFallback updates it via microtask/hook
        queueMicrotask(() => {
          try {
            persistCircuitRecord(circuitBreaker.get(candidate.route.provider));
          } catch {
            // Non-fatal in case DB closed during shutdown
          }
        });
      }
      return {
        emittedAnyChunk,
        latencyMs: Date.now() - start,
      };
    },
    extractErrorMeta: (err) => {
      if (err instanceof ProviderExecutionError) {
        return {
          errorClass: err.errorClass,
          retryable: err.retryable,
          message: err.message,
          retryAfterMs: err.retryAfterMs,
        };
      }
      return {
        errorClass: 'provider_unavailable',
        retryable: true,
        message: err instanceof Error ? err.message : 'Upstream provider error',
      };
    },
  });

  // Ensure circuit breaker states are persisted synchronously before returning
  for (const att of execResult.attempts) {
    persistCircuitRecord(circuitBreaker.get(att.provider));
  }

  const chosen = execResult.selectedCandidate ?? selectedCandidate!;
  params.callbacks.onRouteSelected?.({
    route: chosen.route,
    fallbackOccurred: execResult.fallbackOccurred,
    attemptCount: execResult.attempts.length,
  });

  return {
    selectedRoute: chosen.route,
    fallbackOccurred: execResult.fallbackOccurred,
    attemptCount: execResult.attempts.length,
  };
}

export function getCompatibilityMatrixSnapshot() {
  const { summaries } = buildProviderSnapshots();
  return {
    providers: summaries,
    matrix: MODEL_COMPATIBILITY_MATRIX,
  };
}
