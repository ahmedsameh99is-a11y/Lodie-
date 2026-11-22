import { Router } from 'express';
import { z } from 'zod';
import { sortBrandedModels } from '../../src/shared/modelRegistry';
import { db, evaluateProviderCredentials, mapRowToBrandedModel, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth, requireDeveloper } from '../middleware';
import { testProviderConnection } from '../providers';
import { createRateLimiter, encryptSecret, validateExternalHttpUrl } from '../security';

export const modelsRouter = Router();

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

  const results = await Promise.all(
    models.map(async (model) => {
      if (model.availability === 'disabled') {
        return {
          id: model.id,
          displayName: model.displayName,
          ok: false,
          healthStatus: 'disabled',
          errorClass: null,
          latencyMs: 0,
          message: model.availabilityReason || 'Disabled by administrator',
        };
      }
      const check = await testProviderConnection(model);
      updateModelStmt.run(
        check.healthStatus,
        check.message,
        now,
        check.errorClass,
        check.latencyMs,
        check.ok ? null : check.message,
        model.id
      );

      return {
        id: model.id,
        displayName: model.displayName,
        ok: check.ok,
        healthStatus: check.healthStatus,
        errorClass: check.errorClass,
        latencyMs: check.latencyMs,
        message: check.message,
      };
    })
  );

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
  provider: z.enum(['gemini', 'openai-compatible', 'anthropic-compatible', 'hosted-oss']).optional(),
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
  const result = await testProviderConnection(model);
  const now = new Date().toISOString();

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
