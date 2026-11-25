import { Router } from 'express';
import { z } from 'zod';
import { sortBrandedModels } from '../../src/shared/modelRegistry';
import { getAllMatrixRoutes, MATRIX_UNSUPPORTED_NOTES, MODEL_COMPATIBILITY_MATRIX } from '../../src/shared/providerMatrix';
import type { BrandedModel, ProviderId } from '../../src/shared/types';
import { db, evaluateProviderCredentials, mapRowToBrandedModel, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth, requireDeveloper } from '../middleware';
import {
  buildProviderSnapshots,
  getCircuitBreaker,
  persistCircuitRecord,
  resetProviderCircuit,
} from '../orchestratorRuntime';
import { createGeminiClient, testProviderConnection } from '../providers';
import {
  ALL_PROVIDER_IDS,
  inspectProviderEnvVarNames,
  PROVIDER_CATALOG,
  resolveProviderCredentials,
} from '../providers/catalog';
import { createRateLimiter, encryptSecret, validateExternalHttpUrl } from '../security';

export const modelsRouter = Router();

modelsRouter.get('/admin/capabilities', requireDeveloper, async (_req: AuthenticatedRequest, res) => {
  const envConfigured = {
    gemini: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    groq: Boolean(process.env.GROQ_API_KEY),
    nvidia: Boolean(process.env.NVIDIA_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    deepinfra: Boolean(process.env.DEEPINFRA_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    openaiCustomBaseUrl: Boolean(process.env.OPENAI_BASE_URL),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    hostedOss: Boolean(process.env.HOSTED_OSS_BASE_URL),
  };

  const envVarReport = inspectProviderEnvVarNames();

  let geminiModels: Array<{
    name: string;
    displayName: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedActions?: string[];
    thinking?: boolean;
  }> = [];
  let geminiDiscoveryError: string | null = null;

  const ai = createGeminiClient();
  if (ai) {
    try {
      const pager = await ai.models.list({ config: { pageSize: 50 } });
      for await (const m of pager) {
        geminiModels.push({
          name: String(m.name ?? ''),
          displayName: String(m.displayName ?? m.name ?? ''),
          inputTokenLimit: m.inputTokenLimit,
          outputTokenLimit: m.outputTokenLimit,
          supportedActions: m.supportedActions,
          thinking: m.thinking,
        });
      }
    } catch (err) {
      geminiDiscoveryError = err instanceof Error ? err.message : 'Failed to list Gemini models.';
    }
  }

  let groqModels: Array<{ id: string; owned_by?: string; context_window?: number }> = [];
  let groqDiscoveryError: string | null = null;
  const groqCreds = resolveProviderCredentials({ provider: 'groq' });
  if (groqCreds.configured && groqCreds.apiKey && groqCreds.baseUrl) {
    try {
      const groqResp = await fetch(`${groqCreds.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${groqCreds.apiKey}` },
        signal: AbortSignal.timeout(6_000),
      });
      if (!groqResp.ok) {
        groqDiscoveryError = `HTTP ${groqResp.status}`;
      } else {
        const groqJson = (await groqResp.json()) as {
          data?: Array<{ id?: string; owned_by?: string; context_window?: number }>;
        };
        groqModels = (groqJson.data ?? [])
          .filter((m) => m.id)
          .map((m) => ({
            id: String(m.id),
            owned_by: m.owned_by ? String(m.owned_by) : undefined,
            context_window: typeof m.context_window === 'number' ? m.context_window : undefined,
          }));
      }
    } catch (err) {
      groqDiscoveryError = err instanceof Error ? err.message : 'Failed to list Groq models.';
    }
  }

  let nvidiaModels: Array<{ id: string; owned_by?: string }> = [];
  let nvidiaDiscoveryError: string | null = null;
  const nvidiaCreds = resolveProviderCredentials({ provider: 'nvidia' });
  if (nvidiaCreds.configured && nvidiaCreds.apiKey && nvidiaCreds.baseUrl) {
    try {
      const nvResp = await fetch(`${nvidiaCreds.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${nvidiaCreds.apiKey}` },
        signal: AbortSignal.timeout(6_000),
      });
      if (!nvResp.ok) {
        nvidiaDiscoveryError = `HTTP ${nvResp.status}`;
      } else {
        const nvJson = (await nvResp.json()) as { data?: Array<{ id?: string; owned_by?: string }> };
        nvidiaModels = (nvJson.data ?? [])
          .filter((m) => m.id)
          .map((m) => ({
            id: String(m.id),
            owned_by: m.owned_by ? String(m.owned_by) : undefined,
          }));
      }
    } catch (err) {
      nvidiaDiscoveryError = err instanceof Error ? err.message : 'Failed to list NVIDIA models.';
    }
  }

  let openrouterModels: Array<{
    id: string;
    context_length?: number;
    supportsVision: boolean;
    supportsTools: boolean;
  }> = [];
  let openrouterDiscoveryError: string | null = null;
  const openrouterCreds = resolveProviderCredentials({ provider: 'openrouter' });
  if (openrouterCreds.configured && openrouterCreds.apiKey && openrouterCreds.baseUrl) {
    try {
      const orResp = await fetch(`${openrouterCreds.baseUrl.replace(/\/$/, '')}/models`, {
        headers: {
          Authorization: `Bearer ${openrouterCreds.apiKey}`,
          ...(PROVIDER_CATALOG.openrouter.extraHeaders?.() ?? {}),
        },
        signal: AbortSignal.timeout(6_000),
      });
      if (!orResp.ok) {
        openrouterDiscoveryError = `HTTP ${orResp.status}`;
      } else {
        const orJson = (await orResp.json()) as {
          data?: Array<{
            id?: string;
            context_length?: number;
            architecture?: { input_modalities?: string[] };
            supported_parameters?: string[];
          }>;
        };
        openrouterModels = (orJson.data ?? [])
          .filter((m) => m.id)
          .slice(0, 120)
          .map((m) => ({
            id: String(m.id),
            context_length: typeof m.context_length === 'number' ? m.context_length : undefined,
            supportsVision: Boolean(m.architecture?.input_modalities?.includes('image')),
            supportsTools: Boolean(m.supported_parameters?.includes('tools')),
          }));
      }
    } catch (err) {
      openrouterDiscoveryError = err instanceof Error ? err.message : 'Failed to list OpenRouter models.';
    }
  }

  let deepinfraModels: Array<{
    id: string;
    context_length?: number;
    supportsVision: boolean;
  }> = [];
  let deepinfraDiscoveryError: string | null = null;
  const deepinfraCreds = resolveProviderCredentials({ provider: 'deepinfra' });
  if (deepinfraCreds.configured && deepinfraCreds.apiKey && deepinfraCreds.baseUrl) {
    try {
      const diResp = await fetch(`${deepinfraCreds.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${deepinfraCreds.apiKey}` },
        signal: AbortSignal.timeout(6_000),
      });
      if (!diResp.ok) {
        deepinfraDiscoveryError = `HTTP ${diResp.status}`;
      } else {
        const diJson = (await diResp.json()) as {
          data?: Array<{
            id?: string;
            metadata?: { context_length?: number; tags?: string[] };
          }>;
        };
        deepinfraModels = (diJson.data ?? [])
          .filter((m) => m.id)
          .slice(0, 120)
          .map((m) => ({
            id: String(m.id),
            context_length: typeof m.metadata?.context_length === 'number' ? m.metadata.context_length : undefined,
            supportsVision: Boolean(
              m.metadata?.tags?.includes('vision') || m.metadata?.tags?.includes('vlm')
            ),
          }));
      }
    } catch (err) {
      deepinfraDiscoveryError = err instanceof Error ? err.message : 'Failed to list DeepInfra models.';
    }
  }

  let hostedOssModels: string[] = [];
  let hostedOssError: string | null = null;
  if (process.env.HOSTED_OSS_BASE_URL) {
    try {
      const ossResp = await fetch(`${process.env.HOSTED_OSS_BASE_URL.replace(/\/$/, '')}/models`, {
        headers: process.env.HOSTED_OSS_API_KEY
          ? { Authorization: `Bearer ${process.env.HOSTED_OSS_API_KEY}` }
          : undefined,
        signal: AbortSignal.timeout(4_000),
      });
      if (!ossResp.ok) {
        hostedOssError = `HTTP ${ossResp.status}`;
      } else {
        const ossJson = (await ossResp.json()) as { data?: Array<{ id?: string }> };
        hostedOssModels = (ossJson.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
      }
    } catch (err) {
      hostedOssError = err instanceof Error ? err.message : 'Hosted OSS unreachable';
    }
  }

  const { summaries } = buildProviderSnapshots();
  res.json({
    envConfigured,
    envVarReport,
    geminiModels,
    geminiDiscoveryError,
    groqModels,
    groqDiscoveryError,
    nvidiaModels,
    nvidiaDiscoveryError,
    openrouterModels,
    openrouterDiscoveryError,
    deepinfraModels,
    deepinfraDiscoveryError,
    hostedOssModels,
    hostedOssError,
    providers: summaries,
  });
});

modelsRouter.get('/matrix', requireAuth, (_req: AuthenticatedRequest, res) => {
  const { summaries } = buildProviderSnapshots();
  res.json({
    providers: summaries,
    matrix: MODEL_COMPATIBILITY_MATRIX,
    unsupportedNotes: MATRIX_UNSUPPORTED_NOTES,
  });
});

modelsRouter.get('/providers', requireDeveloper, (_req: AuthenticatedRequest, res) => {
  const { summaries } = buildProviderSnapshots();
  res.json({ providers: summaries });
});

modelsRouter.post('/providers/:providerId/test', requireDeveloper, async (req: AuthenticatedRequest, res) => {
  const providerId = String(req.params.providerId) as ProviderId;
  const entry = (PROVIDER_CATALOG as Record<string, (typeof PROVIDER_CATALOG)[ProviderId] | undefined>)[providerId];
  if (!entry) {
    res.status(404).json({ error: `Unknown provider: ${providerId}` });
    return;
  }
  const bodySchema = z.object({
    upstreamModelId: z.string().trim().min(1).max(160).optional(),
    prompt: z.string().trim().min(1).max(2000).optional(),
    testImage: z.boolean().optional(),
  });
  const parsedBody = bodySchema.safeParse(req.body ?? {});
  const bodyData = parsedBody.success ? parsedBody.data : {};

  const matrixRoute = getAllMatrixRoutes().find((r) => r.provider === providerId);
  const probeUpstreamId = bodyData.upstreamModelId ?? matrixRoute?.upstreamModelId ?? 'probe-model';
  const probeModel: BrandedModel = {
    id: matrixRoute?.brandedModelId ?? `probe-${providerId}`,
    displayName: entry.displayName,
    tier: 'free',
    requiredPlan: 'free',
    provider: providerId,
    upstreamModelId: probeUpstreamId,
    description: `Provider connection probe for ${entry.displayName}`,
    speedClass: 'Fast',
    reasoningLevel: 'Standard',
    contextLimit: matrixRoute?.contextLimit ?? 128_000,
    inputModalities: bodyData.testImage || entry.supportsVision ? ['text', 'image'] : ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsStreaming: true,
    pricingSummary: 'Diagnostic Probe',
    availability: 'connected',
    availabilityReason: 'Provider diagnostic probe',
    lastTestedAt: null,
  };

  const result = await testProviderConnection(probeModel, {
    prompt: bodyData.prompt,
    testImage: bodyData.testImage,
  });
  const cb = getCircuitBreaker();
  if (result.ok) {
    const rec = cb.recordSuccess(providerId, result.latencyMs);
    persistCircuitRecord(rec);
  } else {
    const rec = cb.recordFailure(
      providerId,
      result.errorClass ?? 'provider_unavailable',
      result.message,
      Date.now(),
      result.retryAfterMs
    );
    persistCircuitRecord(rec);
  }

  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'provider_connection_test',
    targetType: 'provider',
    targetId: providerId,
    outcome: result.ok ? 'success' : 'error',
    detail: `${result.message} (${result.latencyMs}ms)`,
  });

  const { summaries } = buildProviderSnapshots();
  res.json({
    testResult: result,
    provider: summaries.find((p) => p.id === providerId) ?? null,
  });
});

modelsRouter.post('/providers/:providerId/reset-circuit', requireDeveloper, (req: AuthenticatedRequest, res) => {
  const providerId = String(req.params.providerId) as ProviderId;
  if (!(providerId in PROVIDER_CATALOG)) {
    res.status(404).json({ error: `Unknown provider: ${providerId}` });
    return;
  }
  resetProviderCircuit(providerId);
  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'provider_circuit_reset',
    targetType: 'provider',
    targetId: providerId,
    outcome: 'success',
    detail: `Circuit breaker reset for ${providerId}`,
  });
  const { summaries } = buildProviderSnapshots();
  res.json({ provider: summaries.find((p) => p.id === providerId) ?? null });
});

const healthCheckLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 6,
  scope: 'models_health',
});

modelsRouter.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM model_registry').all() as Array<Record<string, unknown>>;
  const models = sortBrandedModels(rows.map(mapRowToBrandedModel));
  res.json({ models });
});

modelsRouter.post('/health-check', requireAuth, healthCheckLimiter, async (req: AuthenticatedRequest, res) => {
  const rows = db.prepare('SELECT * FROM model_registry').all() as Array<Record<string, unknown>>;
  const models = sortBrandedModels(rows.map(mapRowToBrandedModel));
  const now = new Date().toISOString();

  const updateModelStmt = db.prepare(`
    UPDATE model_registry
    SET availability = ?, availability_reason = ?, last_tested_at = ?, error_class = ?, avg_latency_ms = ?, last_error_detail = ?
    WHERE id = ?
  `);

  // Group models by provider so distinct providers probe concurrently without stampeding a single API key
  const modelsByProvider = new Map<string, BrandedModel[]>();
  for (const model of models) {
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push(model);
    modelsByProvider.set(model.provider, list);
  }

  const resultMap = new Map<
    string,
    {
      id: string;
      displayName: string;
      ok: boolean;
      healthStatus: string;
      errorClass: string | null;
      latencyMs: number;
      message: string;
    }
  >();

  await Promise.all(
    Array.from(modelsByProvider.values()).map(async (providerModels) => {
      for (let i = 0; i < providerModels.length; i += 1) {
        const model = providerModels[i];
        if (model.availability === 'disabled') {
          resultMap.set(model.id, {
            id: model.id,
            displayName: model.displayName,
            ok: false,
            healthStatus: 'disabled',
            errorClass: null,
            latencyMs: 0,
            message: model.availabilityReason || 'Disabled by administrator',
          });
          continue;
        }
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const primarySupportsVision = Boolean(PROVIDER_CATALOG[model.provider]?.supportsVision);
        const testImage = model.inputModalities.includes('image') && primarySupportsVision;
        const check = await testProviderConnection(model, {
          timeoutMs: 35_000,
          testImage,
          prompt: testImage
            ? 'Confirm what color this 1x1 PNG pixel is in 5 words.'
            : undefined,
        });
        if (check.ok) {
          persistCircuitRecord(getCircuitBreaker().recordSuccess(model.provider, check.latencyMs));
          persistCircuitRecord(
            getCircuitBreaker().recordRouteSuccess(model.provider, model.upstreamModelId, check.latencyMs)
          );
        }
        updateModelStmt.run(
          check.healthStatus,
          check.message,
          now,
          check.errorClass,
          check.latencyMs,
          check.ok ? null : check.message,
          model.id
        );

        resultMap.set(model.id, {
          id: model.id,
          displayName: model.displayName,
          ok: check.ok,
          healthStatus: check.healthStatus,
          errorClass: check.errorClass,
          latencyMs: check.latencyMs,
          message: check.message,
        });
      }
    })
  );

  const results = models.map((m) => resultMap.get(m.id)!);

  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'models_health_check',
    targetType: 'model_registry',
    outcome: 'success',
    detail: `Checked ${results.length} models (${results.filter((r) => r.ok).length} operational)`,
  });

  const refreshed = sortBrandedModels(
    (db.prepare('SELECT * FROM model_registry').all() as Array<Record<string, unknown>>).map(mapRowToBrandedModel)
  );
  res.json({ checkedAt: now, results, models: refreshed });
});

const adminUpdateSchema = z.object({
  provider: z.enum(ALL_PROVIDER_IDS as [ProviderId, ...ProviderId[]]).optional(),
  upstreamModelId: z.string().trim().min(1).max(120).optional(),
  requiredPlan: z.enum(['free', 'premium']).optional(),
  availability: z
    .enum([
      'operational',
      'connected',
      'slow',
      'temporarily_unavailable',
      'configuration_error',
      'authentication_error',
      'awaiting_config',
      'disabled',
      'error',
    ])
    .optional(),
  availabilityReason: z.string().trim().max(240).optional(),
  thinkingPreset: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH']).optional(),
  customBaseUrl: z.string().trim().max(300).optional().nullable(),
  customApiKey: z.string().trim().max(300).optional(),
});

modelsRouter.patch('/admin/:id', requireDeveloper, (req: AuthenticatedRequest, res) => {
  const parsed = adminUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid model update.' });
    return;
  }

  const existing = db.prepare('SELECT * FROM model_registry WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Model not found in registry.' });
    return;
  }

  if (parsed.data.provider === 'github-models') {
    res.status(400).json({
      error: 'GitHub Models inference service was retired on July 30, 2026 and cannot be assigned as an active chat provider.',
    });
    return;
  }

  if (parsed.data.customBaseUrl) {
    const urlCheck = validateExternalHttpUrl(parsed.data.customBaseUrl);
    if (!urlCheck.valid) {
      res.status(400).json({ error: urlCheck.reason ?? 'Invalid custom base URL.' });
      return;
    }
  }

  const nextProvider = parsed.data.provider ?? String(existing.provider);
  const nextUpstream = parsed.data.upstreamModelId ?? String(existing.upstream_model_id);
  const nextPlan = parsed.data.requiredPlan ?? String(existing.required_plan);
  const nextThinking = parsed.data.thinkingPreset ?? (existing.thinking_preset ? String(existing.thinking_preset) : null);
  const nextBaseUrl =
    parsed.data.customBaseUrl !== undefined ? parsed.data.customBaseUrl : (existing.custom_base_url ? String(existing.custom_base_url) : null);

  let nextEncryptedKey = existing.encrypted_api_key ? String(existing.encrypted_api_key) : null;
  if (parsed.data.customApiKey !== undefined) {
    nextEncryptedKey = parsed.data.customApiKey ? encryptSecret(parsed.data.customApiKey) : null;
  }

  const routingChanged =
    parsed.data.provider !== undefined ||
    parsed.data.upstreamModelId !== undefined ||
    parsed.data.customBaseUrl !== undefined ||
    parsed.data.customApiKey !== undefined;

  const credState = evaluateProviderCredentials({
    provider: nextProvider,
    hasEncryptedKey: Boolean(nextEncryptedKey),
    customBaseUrl: nextBaseUrl,
  });

  let nextAvail = parsed.data.availability ?? String(existing.availability);
  let nextReason = parsed.data.availabilityReason ?? String(existing.availability_reason);
  let nextLastTested = existing.last_tested_at ? String(existing.last_tested_at) : null;
  let nextErrorClass = existing.error_class ? String(existing.error_class) : null;
  let nextAvgLatency = existing.avg_latency_ms !== null && existing.avg_latency_ms !== undefined ? Number(existing.avg_latency_ms) : null;
  let nextErrorDetail = existing.last_error_detail ? String(existing.last_error_detail) : null;

  if (routingChanged && parsed.data.availability === undefined) {
    // Re-evaluate credential status cleanly without carrying stale operational proof from an old mapping
    nextAvail = credState.configured ? 'connected' : 'awaiting_config';
    nextReason = parsed.data.availabilityReason ?? (credState.configured ? credState.configuredReason : credState.missingReason);
    nextLastTested = null;
    nextErrorClass = credState.configured ? null : 'configuration_error';
    nextAvgLatency = null;
    nextErrorDetail = null;
  }

  db.prepare(`
    UPDATE model_registry
    SET provider = ?, upstream_model_id = ?, required_plan = ?, availability = ?,
        availability_reason = ?, thinking_preset = ?, custom_base_url = ?, encrypted_api_key = ?,
        last_tested_at = ?, error_class = ?, avg_latency_ms = ?, last_error_detail = ?
    WHERE id = ?
  `).run(
    nextProvider,
    nextUpstream,
    nextPlan,
    nextAvail,
    nextReason,
    nextThinking,
    nextBaseUrl,
    nextEncryptedKey,
    nextLastTested,
    nextErrorClass,
    nextAvgLatency,
    nextErrorDetail,
    req.params.id
  );

  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'model_registry_update',
    targetType: 'model',
    targetId: String(req.params.id),
    outcome: 'success',
    detail: `Updated mapping: provider=${nextProvider}, upstream=${nextUpstream}, plan=${nextPlan}, availability=${nextAvail}`,
  });

  const updated = db.prepare('SELECT * FROM model_registry WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ model: mapRowToBrandedModel(updated) });
});

modelsRouter.post('/admin/:id/test', requireDeveloper, async (req: AuthenticatedRequest, res) => {
  const row = db.prepare('SELECT * FROM model_registry WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Model not found.' });
    return;
  }
  const model = mapRowToBrandedModel(row);
  const primarySupportsVision = Boolean(PROVIDER_CATALOG[model.provider]?.supportsVision);
  const testImage = model.inputModalities.includes('image') && primarySupportsVision;
  const result = await testProviderConnection(model, {
    timeoutMs: 35_000,
    testImage,
    prompt: testImage
      ? 'Confirm what color this 1x1 PNG pixel is in 5 words.'
      : undefined,
  });
  const now = new Date().toISOString();
  if (result.ok) {
    persistCircuitRecord(getCircuitBreaker().recordSuccess(model.provider, result.latencyMs));
  }

  db.prepare(`
    UPDATE model_registry
    SET availability = ?, availability_reason = ?, last_tested_at = ?, error_class = ?, avg_latency_ms = ?, last_error_detail = ?
    WHERE id = ?
  `).run(
    result.healthStatus,
    result.message,
    now,
    result.errorClass,
    result.latencyMs,
    result.ok ? null : result.message,
    model.id
  );

  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'model_connection_test',
    targetType: 'model',
    targetId: model.id,
    outcome: result.ok ? 'success' : 'error',
    detail: `${result.message} (${result.latencyMs}ms)`,
  });

  const updated = db.prepare('SELECT * FROM model_registry WHERE id = ?').get(model.id) as Record<string, unknown>;
  res.json({
    testResult: result,
    model: mapRowToBrandedModel(updated),
  });
});
