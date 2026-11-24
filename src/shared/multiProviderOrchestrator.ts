import type {
  CircuitState,
  ErrorClass,
  MatrixRouteDescriptor,
  OrchestratorMode,
  ProviderId,
} from './types';

export interface CircuitRecord {
  provider: ProviderId;
  state: CircuitState;
  consecutiveFailures: number;
  failureCount: number;
  successCount: number;
  avgLatencyMs: number | null;
  lastErrorClass: ErrorClass | null;
  lastError: string | null;
  cooldownUntilMs: number | null;
  lastCheckedAt: string | null;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

const IMMEDIATE_OPEN_ERRORS = new Set<ErrorClass>([
  'auth_error',
  'quota_exceeded',
  'configuration_error',
]);

export class CircuitBreakerRegistry {
  private readonly records = new Map<ProviderId, CircuitRecord>();
  private readonly routeRecords = new Map<string, CircuitRecord>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 30_000);
  }

  private routeKey(provider: ProviderId, upstreamModelId: string): string {
    return `${provider}::${upstreamModelId}`;
  }

  hydrate(record: CircuitRecord): void {
    this.records.set(record.provider, { ...record });
  }

  get(provider: ProviderId): CircuitRecord {
    const existing = this.records.get(provider);
    if (existing) return { ...existing };
    return {
      provider,
      state: 'closed',
      consecutiveFailures: 0,
      failureCount: 0,
      successCount: 0,
      avgLatencyMs: null,
      lastErrorClass: null,
      lastError: null,
      cooldownUntilMs: null,
      lastCheckedAt: null,
    };
  }

  getRoute(provider: ProviderId, upstreamModelId: string): CircuitRecord {
    const key = this.routeKey(provider, upstreamModelId);
    const existing = this.routeRecords.get(key);
    if (existing) return { ...existing };
    return {
      provider,
      state: 'closed',
      consecutiveFailures: 0,
      failureCount: 0,
      successCount: 0,
      avgLatencyMs: null,
      lastErrorClass: null,
      lastError: null,
      cooldownUntilMs: null,
      lastCheckedAt: null,
    };
  }

  listAll(): CircuitRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  private evaluateRecordAttempt(
    map: { get: (k: any) => CircuitRecord | undefined; set: (k: any, v: CircuitRecord) => void },
    key: any,
    rec: CircuitRecord,
    nowMs: number
  ): { allowed: boolean; state: CircuitState } {
    if (rec.state === 'closed') {
      return { allowed: true, state: 'closed' };
    }
    if (rec.state === 'open') {
      if (rec.cooldownUntilMs !== null && nowMs >= rec.cooldownUntilMs) {
        rec.state = 'half_open';
        map.set(key, rec);
        return { allowed: true, state: 'half_open' };
      }
      return { allowed: false, state: 'open' };
    }
    return { allowed: true, state: 'half_open' };
  }

  canAttempt(provider: ProviderId, nowMs = Date.now()): { allowed: boolean; state: CircuitState } {
    return this.evaluateRecordAttempt(this.records, provider, this.get(provider), nowMs);
  }

  canAttemptRoute(
    provider: ProviderId,
    upstreamModelId: string,
    nowMs = Date.now()
  ): { allowed: boolean; state: CircuitState } {
    const provCheck = this.canAttempt(provider, nowMs);
    if (!provCheck.allowed) return provCheck;
    const key = this.routeKey(provider, upstreamModelId);
    const routeCheck = this.evaluateRecordAttempt(
      this.routeRecords,
      key,
      this.getRoute(provider, upstreamModelId),
      nowMs
    );
    if (!routeCheck.allowed) return routeCheck;
    return {
      allowed: true,
      state: routeCheck.state === 'half_open' || provCheck.state === 'half_open' ? 'half_open' : 'closed',
    };
  }

  private buildSuccessRecord(prev: CircuitRecord, provider: ProviderId, latencyMs: number, nowMs: number): CircuitRecord {
    const clampedLat = Math.max(1, Math.round(latencyMs));
    const avgLatencyMs =
      prev.avgLatencyMs === null
        ? clampedLat
        : Math.round(prev.avgLatencyMs * 0.65 + clampedLat * 0.35);

    return {
      provider,
      state: 'closed',
      consecutiveFailures: 0,
      failureCount: prev.failureCount,
      successCount: prev.successCount + 1,
      avgLatencyMs,
      lastErrorClass: null,
      lastError: null,
      cooldownUntilMs: null,
      lastCheckedAt: new Date(nowMs).toISOString(),
    };
  }

  recordSuccess(provider: ProviderId, latencyMs: number, nowMs = Date.now()): CircuitRecord {
    const next = this.buildSuccessRecord(this.get(provider), provider, latencyMs, nowMs);
    this.records.set(provider, next);
    return { ...next };
  }

  recordRouteSuccess(
    provider: ProviderId,
    upstreamModelId: string,
    latencyMs: number,
    nowMs = Date.now()
  ): CircuitRecord {
    const key = this.routeKey(provider, upstreamModelId);
    const nextRoute = this.buildSuccessRecord(this.getRoute(provider, upstreamModelId), provider, latencyMs, nowMs);
    this.routeRecords.set(key, nextRoute);
    return this.recordSuccess(provider, latencyMs, nowMs);
  }

  private buildFailureRecord(
    prev: CircuitRecord,
    provider: ProviderId,
    errorClass: ErrorClass,
    errorMessage: string,
    nowMs: number,
    retryAfterMs?: number
  ): CircuitRecord {
    const consecutiveFailures = prev.consecutiveFailures + 1;
    const immediateOpen = IMMEDIATE_OPEN_ERRORS.has(errorClass);
    const hasExplicitRetryAfter = typeof retryAfterMs === 'number' && retryAfterMs > 0;
    const shouldOpen =
      prev.state === 'half_open' ||
      immediateOpen ||
      (errorClass === 'rate_limit' && hasExplicitRetryAfter) ||
      consecutiveFailures >= this.failureThreshold;

    const cooldownMultiplier = errorClass === 'quota_exceeded' || errorClass === 'auth_error' ? 4 : 1;
    const defaultCooldown = this.cooldownMs * cooldownMultiplier;
    const boundedRetryAfter = hasExplicitRetryAfter ? Math.min(Math.max(retryAfterMs!, 1_000), 600_000) : 0;
    const effectiveCooldown = Math.max(defaultCooldown, boundedRetryAfter);

    return {
      provider,
      state: shouldOpen ? 'open' : prev.state,
      consecutiveFailures,
      failureCount: prev.failureCount + 1,
      successCount: prev.successCount,
      avgLatencyMs: prev.avgLatencyMs,
      lastErrorClass: errorClass,
      lastError: errorMessage.slice(0, 320),
      cooldownUntilMs: shouldOpen ? nowMs + effectiveCooldown : prev.cooldownUntilMs,
      lastCheckedAt: new Date(nowMs).toISOString(),
    };
  }

  recordFailure(
    provider: ProviderId,
    errorClass: ErrorClass,
    errorMessage: string,
    nowMs = Date.now(),
    retryAfterMs?: number
  ): CircuitRecord {
    const next = this.buildFailureRecord(this.get(provider), provider, errorClass, errorMessage, nowMs, retryAfterMs);
    this.records.set(provider, next);
    return { ...next };
  }

  recordRouteFailure(
    provider: ProviderId,
    upstreamModelId: string,
    errorClass: ErrorClass,
    errorMessage: string,
    nowMs = Date.now(),
    retryAfterMs?: number
  ): CircuitRecord {
    const key = this.routeKey(provider, upstreamModelId);
    const nextRoute = this.buildFailureRecord(
      this.getRoute(provider, upstreamModelId),
      provider,
      errorClass,
      errorMessage,
      nowMs,
      retryAfterMs
    );
    this.routeRecords.set(key, nextRoute);

    // Only auth_error / configuration_error lock the whole provider credential;
    // model-specific quota_exceeded / latency / rate_limit stay scoped to the failing upstream model
    if (errorClass === 'auth_error' || errorClass === 'configuration_error') {
      return this.recordFailure(provider, errorClass, errorMessage, nowMs, retryAfterMs);
    }

    const prevProv = this.get(provider);
    const updatedTelemetry: CircuitRecord = {
      ...prevProv,
      failureCount: prevProv.failureCount + 1,
      lastErrorClass: errorClass,
      lastError: errorMessage.slice(0, 320),
      lastCheckedAt: new Date(nowMs).toISOString(),
    };
    this.records.set(provider, updatedTelemetry);
    return { ...updatedTelemetry };
  }

  reset(provider: ProviderId): CircuitRecord {
    const prev = this.get(provider);
    const next: CircuitRecord = {
      ...prev,
      state: 'closed',
      consecutiveFailures: 0,
      lastErrorClass: null,
      lastError: null,
      cooldownUntilMs: null,
    };
    this.records.set(provider, next);
    for (const key of this.routeRecords.keys()) {
      if (key.startsWith(`${provider}::`)) {
        this.routeRecords.delete(key);
      }
    }
    return { ...next };
  }
}

export interface ProviderRuntimeAvailability {
  configured: boolean;
  retired: boolean;
  todaySpendUsd: number;
  dailyBudgetUsd: number;
  todayRequests: number;
  dailyRequestCap: number;
}

export interface RoutePlanParams {
  brandedModelId: string;
  routes: MatrixRouteDescriptor[];
  registryPrimary?: {
    provider: ProviderId;
    upstreamModelId: string;
    contextLimit?: number | null;
    supportsVision: boolean;
    supportsStreaming: boolean;
    supportsTools: boolean;
  };
  providerStatus: Record<string, ProviderRuntimeAvailability>;
  circuitBreaker: CircuitBreakerRegistry;
  hasImageAttachments: boolean;
  requiresStreaming: boolean;
  estimatedInputTokens: number;
  intentMode: OrchestratorMode;
  promptLanguage: 'ar' | 'en';
  rotationSeed?: number;
  nowMs?: number;
}

export interface PlannedRouteCandidate {
  route: MatrixRouteDescriptor;
  score: number;
  circuitState: CircuitState;
  reasons: string[];
}

export interface SkippedRouteReason {
  routeId: string;
  provider: ProviderId;
  reason: string;
}

export function detectPromptLanguage(text: string): 'ar' | 'en' {
  return /[\u0600-\u06FF]/.test(text) ? 'ar' : 'en';
}

export function planProviderRoutes(params: RoutePlanParams): {
  candidates: PlannedRouteCandidate[];
  skipped: SkippedRouteReason[];
} {
  const nowMs = params.nowMs ?? Date.now();
  const candidates: PlannedRouteCandidate[] = [];
  const skipped: SkippedRouteReason[] = [];

  // Build deduplicated route list starting with active Developer registry primary if distinct
  const mergedRoutes: MatrixRouteDescriptor[] = [];
  const seenKeys = new Set<string>();

  if (params.registryPrimary) {
    const regKey = `${params.registryPrimary.provider}::${params.registryPrimary.upstreamModelId}`;
    const matchingMatrix = params.routes.find(
      (r) =>
        r.provider === params.registryPrimary!.provider &&
        r.upstreamModelId === params.registryPrimary!.upstreamModelId
    );
    const textOnlyProviders = new Set<ProviderId>(['groq', 'cohere', 'ai21', 'cerebras', 'sambanova']);
    const resolvedVision = textOnlyProviders.has(params.registryPrimary.provider)
      ? false
      : matchingMatrix
        ? matchingMatrix.supportsVision
        : params.registryPrimary.supportsVision;
    mergedRoutes.push({
      id: matchingMatrix?.id ?? `${params.brandedModelId}::registry-primary`,
      brandedModelId: params.brandedModelId,
      provider: params.registryPrimary.provider,
      upstreamModelId: params.registryPrimary.upstreamModelId,
      priority: 0,
      contextLimit: params.registryPrimary.contextLimit ?? matchingMatrix?.contextLimit ?? 128_000,
      supportsVision: resolvedVision,
      supportsTools: params.registryPrimary.supportsTools,
      supportsStreaming: params.registryPrimary.supportsStreaming,
      supportsPromptCaching:
        matchingMatrix?.supportsPromptCaching ?? params.registryPrimary.provider === 'anthropic-compatible',
      costTier: matchingMatrix?.costTier ?? 'balanced',
      speedTier: matchingMatrix?.speedTier ?? 'balanced',
      arabicStrength: matchingMatrix?.arabicStrength ?? 'medium',
      taskAffinities: matchingMatrix?.taskAffinities ?? ['auto'],
    });
    seenKeys.add(regKey);
  }

  for (const route of params.routes) {
    const key = `${route.provider}::${route.upstreamModelId}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    mergedRoutes.push(route);
  }

  for (const route of mergedRoutes) {
    const avail = params.providerStatus[route.provider];
    if (!avail) {
      skipped.push({ routeId: route.id, provider: route.provider, reason: 'Provider not registered' });
      continue;
    }
    if (avail.retired) {
      skipped.push({ routeId: route.id, provider: route.provider, reason: 'Provider retired / unsupported' });
      continue;
    }
    if (!avail.configured) {
      skipped.push({ routeId: route.id, provider: route.provider, reason: 'Awaiting provider credentials' });
      continue;
    }
    if (params.hasImageAttachments && !route.supportsVision) {
      skipped.push({ routeId: route.id, provider: route.provider, reason: 'Text-only route for image input' });
      continue;
    }
    if (params.requiresStreaming && !route.supportsStreaming) {
      skipped.push({ routeId: route.id, provider: route.provider, reason: 'Streaming unsupported' });
      continue;
    }
    const maxSafeInput = Math.floor(route.contextLimit * 0.92);
    if (params.estimatedInputTokens > maxSafeInput) {
      skipped.push({
        routeId: route.id,
        provider: route.provider,
        reason: `Input (${params.estimatedInputTokens}) exceeds context headroom (${maxSafeInput})`,
      });
      continue;
    }
    if (avail.dailyBudgetUsd > 0 && avail.todaySpendUsd >= avail.dailyBudgetUsd) {
      skipped.push({ routeId: route.id, provider: route.provider, reason: 'Daily provider spend budget reached' });
      continue;
    }
    if (avail.dailyRequestCap > 0 && avail.todayRequests >= avail.dailyRequestCap) {
      skipped.push({ routeId: route.id, provider: route.provider, reason: 'Daily provider request cap reached' });
      continue;
    }

    const circuit = params.circuitBreaker.canAttemptRoute(route.provider, route.upstreamModelId, nowMs);
    if (!circuit.allowed) {
      skipped.push({ routeId: route.id, provider: route.provider, reason: 'Circuit breaker open' });
      continue;
    }

    const rec = params.circuitBreaker.get(route.provider);
    const routeRec = params.circuitBreaker.getRoute(route.provider, route.upstreamModelId);
    const reasons: string[] = [];
    let score = 100 - route.priority * 6;

    if (route.priority === 0) {
      score += 24;
      reasons.push('registry_primary');
    }
    if (route.taskAffinities.includes(params.intentMode)) {
      score += 12;
      reasons.push(`task:${params.intentMode}`);
    }
    if (params.promptLanguage === 'ar') {
      if (route.arabicStrength === 'high') {
        score += 10;
        reasons.push('arabic_high');
      } else if (route.arabicStrength === 'medium') {
        score += 4;
      }
    }
    if (params.intentMode === 'fast') {
      if (route.speedTier === 'ultra_fast') score += 10;
      else if (route.speedTier === 'fast') score += 6;
      if (route.costTier === 'free' || route.costTier === 'low') score += 4;
    }
    if (route.supportsPromptCaching && params.estimatedInputTokens > 1_200) {
      score += 6;
      reasons.push('prompt_caching');
    }
    if (rec.successCount === 0 && rec.failureCount > 0) {
      // Strongly deprioritize routes on providers that have never succeeded so they never outscore proven healthy routes
      const penalty = rec.lastErrorClass === 'auth_error' || rec.lastErrorClass === 'quota_exceeded' ? 60 : 35;
      score -= penalty;
      reasons.push('unproven_failing_provider');
    } else if (routeRec.avgLatencyMs !== null) {
      score -= Math.min(8, Math.floor(routeRec.avgLatencyMs / 1500));
    } else if (rec.avgLatencyMs !== null) {
      score -= Math.min(8, Math.floor(rec.avgLatencyMs / 1500));
    }
    if (routeRec.lastErrorClass === 'quota_exceeded' && routeRec.consecutiveFailures > 0) {
      score -= 25;
      reasons.push('route_quota_limited');
    }
    if (circuit.state === 'half_open') {
      score -= 10;
      reasons.push('half_open_probe');
    }

    // Controlled bounded load-distribution jitter across fallback sibling routes only (never overrides priority 0/1 primary)
    if (route.priority > 1 && typeof params.rotationSeed === 'number' && mergedRoutes.length > 2) {
      const slotBoost = ((route.priority + params.rotationSeed) % mergedRoutes.length) === 0 ? 3 : 0;
      score += slotBoost;
    }

    candidates.push({
      route,
      score,
      circuitState: circuit.state,
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.route.priority - b.route.priority);
  return { candidates, skipped };
}

/**
 * Slides out oldest history turns while preserving the latest user prompt
 * when cumulative tokens exceed the selected provider's context window ceiling.
 */
export function trimMessagesForContextBudget<T extends { role: 'user' | 'assistant'; content: string }>(
  messages: T[],
  systemTokens: number,
  targetContextLimit: number
): { messages: T[]; trimmedTurns: number } {
  if (messages.length <= 1) return { messages, trimmedTurns: 0 };
  const safeLimit = Math.max(1_000, Math.floor(targetContextLimit * 0.85) - systemTokens);
  const estimate = (msg: T) => Math.max(4, Math.ceil(msg.content.length / 4));

  const kept: T[] = [];
  let running = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimate(messages[i]);
    if (kept.length > 0 && running + cost > safeLimit) {
      break;
    }
    kept.unshift(messages[i]);
    running += cost;
  }

  return {
    messages: kept,
    trimmedTurns: messages.length - kept.length,
  };
}

export interface FallbackAttemptLog {
  provider: ProviderId;
  upstreamModelId: string;
  ok: boolean;
  latencyMs: number;
  errorClass?: ErrorClass;
  errorMessage?: string;
}

export async function executeWithMultiProviderFallback<TMeta extends { errorClass?: ErrorClass }>(params: {
  candidates: PlannedRouteCandidate[];
  circuitBreaker: CircuitBreakerRegistry;
  maxRetries?: number;
  signal?: AbortSignal;
  onAttemptStart?: (info: {
    candidate: PlannedRouteCandidate;
    attemptIndex: number;
    fallbackOccurred: boolean;
    previousError?: string;
    previousErrorClass?: ErrorClass;
  }) => void;
  invoke: (
    candidate: PlannedRouteCandidate,
    controls: { hasEmittedChunk: () => boolean }
  ) => Promise<{ emittedAnyChunk: boolean; latencyMs?: number }>;
  extractErrorMeta: (err: unknown) => {
    errorClass: ErrorClass;
    retryable: boolean;
    message: string;
    retryAfterMs?: number;
  };
}): Promise<{
  selectedCandidate: PlannedRouteCandidate;
  attempts: FallbackAttemptLog[];
  fallbackOccurred: boolean;
}> {
  if (params.candidates.length === 0) {
    throw new Error('No eligible configured provider routes available for this request.');
  }

  const maxAttempts = Math.min(params.candidates.length, Math.max(1, (params.maxRetries ?? 2) + 1));
  const attempts: FallbackAttemptLog[] = [];
  let lastError: unknown;
  let lastErrorMeta: { errorClass: ErrorClass; message: string } | null = null;

  for (let idx = 0; idx < maxAttempts; idx++) {
    if (params.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const candidate = params.candidates[idx];
    params.onAttemptStart?.({
      candidate,
      attemptIndex: idx,
      fallbackOccurred: idx > 0,
      previousError: lastErrorMeta?.message,
      previousErrorClass: lastErrorMeta?.errorClass,
    });

    let emittedInAttempt = false;
    const started = Date.now();
    try {
      const outcome = await params.invoke(candidate, {
        hasEmittedChunk: () => emittedInAttempt,
      });
      if (outcome.emittedAnyChunk) emittedInAttempt = true;
      const latencyMs = outcome.latencyMs ?? Date.now() - started;

      if (!emittedInAttempt) {
        const emptyErr = new Error(
          `${candidate.route.provider}/${candidate.route.upstreamModelId} returned an empty response.`
        );
        params.circuitBreaker.recordRouteFailure(
          candidate.route.provider,
          candidate.route.upstreamModelId,
          'provider_unavailable',
          emptyErr.message
        );
        attempts.push({
          provider: candidate.route.provider,
          upstreamModelId: candidate.route.upstreamModelId,
          ok: false,
          latencyMs,
          errorClass: 'provider_unavailable',
          errorMessage: emptyErr.message,
        });
        lastError = emptyErr;
        lastErrorMeta = { errorClass: 'provider_unavailable', message: emptyErr.message };
        continue;
      }

      params.circuitBreaker.recordRouteSuccess(candidate.route.provider, candidate.route.upstreamModelId, latencyMs);
      attempts.push({
        provider: candidate.route.provider,
        upstreamModelId: candidate.route.upstreamModelId,
        ok: true,
        latencyMs,
      });

      return {
        selectedCandidate: candidate,
        attempts,
        fallbackOccurred: idx > 0,
      };
    } catch (err) {
      lastError = err;
      if (params.signal?.aborted || (err as { name?: string })?.name === 'AbortError') {
        throw err;
      }

      const latencyMs = Date.now() - started;
      const meta = params.extractErrorMeta(err);
      lastErrorMeta = { errorClass: meta.errorClass, message: meta.message };
      params.circuitBreaker.recordRouteFailure(
        candidate.route.provider,
        candidate.route.upstreamModelId,
        meta.errorClass,
        meta.message,
        Date.now(),
        meta.retryAfterMs
      );
      attempts.push({
        provider: candidate.route.provider,
        upstreamModelId: candidate.route.upstreamModelId,
        ok: false,
        latencyMs,
        errorClass: meta.errorClass,
        errorMessage: meta.message,
      });

      // Never double-stream or retry non-recoverable input validation failures
      if (meta.errorClass === 'validation_error') {
        throw err;
      }
      // If partial output already streamed to caller, caller must handle recovery
      if ((err as TMeta & { partialEmitted?: boolean })?.partialEmitted) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All configured provider routes failed.');
}

interface CacheEntry {
  text: string;
  inputTokens: number;
  outputTokens: number;
  provider: ProviderId;
  upstreamModelId: string;
  expiresAtMs: number;
}

/**
 * Strict TTL response cache exclusively for safe deterministic, attachment-free,
 * memory-free, single-turn utility/diagnostic prompts. Never stores private multi-turn chats.
 */
export class DeterministicResponseCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = Math.max(10, options.maxEntries ?? 100);
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 300_000);
  }

  get(key: string, nowMs = Date.now()): CacheEntry | null {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (nowMs >= hit.expiresAtMs) {
      this.store.delete(key);
      return null;
    }
    return hit;
  }

  set(key: string, entry: Omit<CacheEntry, 'expiresAtMs'>, nowMs = Date.now()): void {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(key, {
      ...entry,
      expiresAtMs: nowMs + this.ttlMs,
    });
  }

  clear(): void {
    this.store.clear();
  }
}

export { buildLoodyIdentityDirective } from './assistantPolicy';

