import { Router } from 'express';
import { z } from 'zod';
import { db, mapRowToBrandedModel, recordAuditLog } from '../db';
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
  const order = ['sonic-3', 'sonic-3.5', 'lodie-5.5', 'fables-5.3', 'loody-vision-1'];
  const models = rows
    .map(mapRowToBrandedModel)
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  res.json({ models });
});

modelsRouter.post('/health-check', requireAuth, healthCheckLimiter, async (req: AuthenticatedRequest, res) => {
  const rows = db.prepare('SELECT * FROM model_registry').all() as Array<Record<string, unknown>>;
  const now = new Date().toISOString();
  const results: Array<{
    id: string;
    displayName: string;
    ok: boolean;
    healthStatus: string;
    errorClass: string | null;
    latencyMs: number;
    message: string;
  }> = [];

  for (const row of rows) {
    const model = mapRowToBrandedModel(row);
    const check = await testProviderConnection(model);
    db.prepare(`
      UPDATE model_registry
      SET availability = ?, availability_reason = ?, last_tested_at = ?, error_class = ?, avg_latency_ms = ?
      WHERE id = ?
    `).run(check.healthStatus, check.message, now, check.errorClass, check.latencyMs, model.id);

    results.push({
      id: model.id,
      displayName: model.displayName,
      ok: check.ok,
      healthStatus: check.healthStatus,
      errorClass: check.errorClass,
      latencyMs: check.latencyMs,
      message: check.message,
    });
  }

  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'models_health_check',
    targetType: 'model_registry',
    outcome: 'success',
    detail: `Checked ${results.length} models`,
  });

  const refreshed = (db.prepare('SELECT * FROM model_registry').all() as Array<Record<string, unknown>>)
    .map(mapRowToBrandedModel);
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
  const nextAvail = parsed.data.availability ?? String(existing.availability);
  const nextReason = parsed.data.availabilityReason ?? String(existing.availability_reason);
  const nextThinking = parsed.data.thinkingPreset ?? (existing.thinking_preset ? String(existing.thinking_preset) : null);
  const nextBaseUrl =
    parsed.data.customBaseUrl !== undefined ? parsed.data.customBaseUrl : (existing.custom_base_url ? String(existing.custom_base_url) : null);

  let nextEncryptedKey = existing.encrypted_api_key ? String(existing.encrypted_api_key) : null;
  if (parsed.data.customApiKey !== undefined) {
    nextEncryptedKey = parsed.data.customApiKey ? encryptSecret(parsed.data.customApiKey) : null;
  }

  db.prepare(`
    UPDATE model_registry
    SET provider = ?, upstream_model_id = ?, required_plan = ?, availability = ?,
        availability_reason = ?, thinking_preset = ?, custom_base_url = ?, encrypted_api_key = ?
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
    SET availability = ?, availability_reason = ?, last_tested_at = ?, error_class = ?, avg_latency_ms = ?
    WHERE id = ?
  `).run(
    result.healthStatus,
    result.message,
    now,
    result.errorClass,
    result.latencyMs,
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
