import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { buildUnifiedSystemInstruction, wrapUntrustedContext } from '../../src/shared/assistantPolicy';
import { validateSkillDefinition } from '../../src/shared/orchestrator';
import { computeEstimatedCostUsd, reconcileTokenRecord } from '../../src/shared/quotas';
import { db, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth } from '../middleware';
import { generateModelText } from '../providers';
import { createRateLimiter } from '../security';
import { runBuiltinToolById } from '../tools/engine';

export const skillsRouter = Router();
skillsRouter.use(requireAuth);
const skillExecuteLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30, scope: 'skills_exec' });

function mapSkillRow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    ownerUserId: r.owner_user_id ? String(r.owner_user_id) : null,
    projectId: r.project_id ? String(r.project_id) : null,
    name: String(r.name),
    version: String(r.version),
    description: String(r.description),
    category: String(r.category),
    inputSchema: JSON.parse(String(r.input_schema_json || '{}')),
    outputSchema: JSON.parse(String(r.output_schema_json || '{}')),
    allowedTools: JSON.parse(String(r.allowed_tools_json || '[]')) as string[],
    promptTemplate: String(r.prompt_template),
    isBuiltin: Boolean(r.is_builtin),
    enabled: Boolean(r.enabled),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

skillsRouter.get('/', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare('SELECT * FROM skills_registry WHERE owner_user_id IS NULL OR owner_user_id = ? ORDER BY is_builtin DESC, updated_at DESC')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;
  res.json({ skills: rows.map(mapSkillRow) });
});

const skillCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  version: z.string().trim().regex(/^\d+\.\d+\.\d+$/, 'Version must be semver (e.g., 1.0.0)').default('1.0.0'),
  description: z.string().trim().min(8).max(500),
  category: z.string().trim().min(2).max(50).default('Custom'),
  projectId: z.string().trim().nullable().optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({ input: 'string' }),
  outputSchema: z.record(z.string(), z.unknown()).default({ result: 'string' }),
  allowedTools: z.array(z.string().trim()).max(12).default([]),
  promptTemplate: z.string().trim().min(10).max(6000),
});

skillsRouter.post('/', (req: AuthenticatedRequest, res) => {
  const parsed = skillCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid skill package.' });
    return;
  }

  const check = validateSkillDefinition(parsed.data);
  if (!check.valid) {
    res.status(400).json({ error: check.errors[0] });
    return;
  }

  const userId = req.authUser!.id;
  if (parsed.data.projectId) {
    const owns = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(parsed.data.projectId, userId);
    if (!owns) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
  }

  const id = `skill_${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO skills_registry (
      id, owner_user_id, project_id, name, version, description, category,
      input_schema_json, output_schema_json, allowed_tools_json, prompt_template,
      is_builtin, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(
    id,
    userId,
    parsed.data.projectId ?? null,
    parsed.data.name,
    parsed.data.version,
    parsed.data.description,
    parsed.data.category,
    JSON.stringify(parsed.data.inputSchema),
    JSON.stringify(parsed.data.outputSchema),
    JSON.stringify(parsed.data.allowedTools),
    parsed.data.promptTemplate,
    now,
    now
  );

  recordAuditLog({
    actorUserId: userId,
    actorEmail: req.authUser!.email,
    action: 'skill_created',
    targetType: 'skill',
    targetId: id,
    outcome: 'success',
    detail: `Created skill ${parsed.data.name}@${parsed.data.version}`,
  });

  const row = db.prepare('SELECT * FROM skills_registry WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json({ skill: mapSkillRow(row) });
});

skillsRouter.patch('/:id', (req: AuthenticatedRequest, res) => {
  const row = db.prepare('SELECT * FROM skills_registry WHERE id = ?').get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Skill not found.' });
    return;
  }
  const isBuiltin = Boolean(row.is_builtin);
  if (isBuiltin && req.authUser!.role !== 'developer' && req.authUser!.role !== 'admin') {
    res.status(403).json({ error: 'Developer role required to modify built-in skills.' });
    return;
  }
  if (!isBuiltin && row.owner_user_id !== req.authUser!.id) {
    res.status(403).json({ error: 'Not authorized to modify this skill.' });
    return;
  }

  const schema = z.object({
    enabled: z.boolean().optional(),
    name: z.string().trim().min(2).max(80).optional(),
    category: z.string().trim().min(2).max(50).optional(),
    version: z.string().trim().regex(/^\d+\.\d+\.\d+$/, 'Version must be semver (e.g., 1.0.0)').optional(),
    description: z.string().trim().min(8).max(500).optional(),
    allowedTools: z.array(z.string().trim()).max(16).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    promptTemplate: z.string().trim().min(10).max(6000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid skill update.' });
    return;
  }

  const nextName = isBuiltin ? String(row.name) : parsed.data.name ?? String(row.name);
  const nextCategory = isBuiltin ? String(row.category) : parsed.data.category ?? String(row.category);
  const nextVersion = isBuiltin ? String(row.version) : parsed.data.version ?? String(row.version);
  const nextDescription = isBuiltin ? String(row.description) : parsed.data.description ?? String(row.description);
  const nextPromptTemplate = isBuiltin
    ? String(row.prompt_template)
    : parsed.data.promptTemplate ?? String(row.prompt_template);
  const nextAllowedTools = isBuiltin
    ? (JSON.parse(String(row.allowed_tools_json || '[]')) as string[])
    : parsed.data.allowedTools ?? (JSON.parse(String(row.allowed_tools_json || '[]')) as string[]);
  const nextInputSchema = isBuiltin
    ? JSON.parse(String(row.input_schema_json || '{}'))
    : parsed.data.inputSchema ?? JSON.parse(String(row.input_schema_json || '{}'));
  const nextOutputSchema = isBuiltin
    ? JSON.parse(String(row.output_schema_json || '{}'))
    : parsed.data.outputSchema ?? JSON.parse(String(row.output_schema_json || '{}'));

  if (!isBuiltin) {
    const check = validateSkillDefinition({
      name: nextName,
      version: nextVersion,
      description: nextDescription,
      promptTemplate: nextPromptTemplate,
      allowedTools: nextAllowedTools,
    });
    if (!check.valid) {
      res.status(400).json({ error: check.errors[0] });
      return;
    }
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE skills_registry
    SET enabled = ?,
        name = ?,
        category = ?,
        version = ?,
        description = ?,
        allowed_tools_json = ?,
        input_schema_json = ?,
        output_schema_json = ?,
        prompt_template = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    parsed.data.enabled !== undefined ? (parsed.data.enabled ? 1 : 0) : Number(row.enabled),
    nextName,
    nextCategory,
    nextVersion,
    nextDescription,
    JSON.stringify(nextAllowedTools),
    JSON.stringify(nextInputSchema),
    JSON.stringify(nextOutputSchema),
    nextPromptTemplate,
    now,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM skills_registry WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ skill: mapSkillRow(updated) });
});

skillsRouter.delete('/:id', (req: AuthenticatedRequest, res) => {
  const result = db
    .prepare('DELETE FROM skills_registry WHERE id = ? AND owner_user_id = ? AND is_builtin = 0')
    .run(req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Custom skill not found or built-in skill cannot be deleted.' });
    return;
  }
  res.json({ ok: true });
});

skillsRouter.post('/:id/execute', skillExecuteLimiter, async (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM skills_registry WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Skill not found.' });
    return;
  }
  const skill = mapSkillRow(row);
  if (!skill.enabled) {
    res.status(403).json({ error: `Skill "${skill.name}" is currently disabled.` });
    return;
  }

  const inputPayload = typeof req.body?.input === 'string' ? req.body.input : JSON.stringify(req.body?.input ?? {}, null, 2);
  if (!inputPayload.trim()) {
    res.status(400).json({ error: 'Skill input payload is required.' });
    return;
  }

  // Run declared safe tools when relevant
  const toolOutputs: Array<{ toolId: string; ok: boolean; data: unknown }> = [];
  for (const tid of skill.allowedTools) {
    let toolArgs: Record<string, unknown> = {};
    if (tid === 'js_ts_ast_static_check') toolArgs = { code: inputPayload };
    else if (tid === 'csv_stats_profiler') toolArgs = { csv: inputPayload };
    else if (tid === 'json_schema_validator') toolArgs = { payload: inputPayload };
    else if (tid === 'gemini_web_search') toolArgs = { query: inputPayload.slice(0, 260) };
    else if (tid === 'utc_clock') toolArgs = { timezone: 'UTC' };
    else if (tid === 'token_budget_estimator') toolArgs = { text: inputPayload };
    else continue;

    const r = await runBuiltinToolById({
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      toolId: tid,
      input: toolArgs,
    });
    toolOutputs.push({ toolId: tid, ok: r.ok, data: r.output ?? r.error });
  }

  const prompt = skill.promptTemplate.replace('{{input}}', inputPayload.slice(0, 12000));
  const toolSection =
    toolOutputs.length > 0
      ? `\n\nDeclared Skill Tool Results:\n${wrapUntrustedContext({
          kind: 'tool_output',
          name: `skill:${skill.id}`,
          content: JSON.stringify(toolOutputs, null, 2),
          maxChars: 5000,
        })}`
      : '';

  try {
    const gen = await generateModelText({
      upstreamModelId: 'gemini-3.1-flash-lite',
      thinkingPreset: 'MEDIUM',
      systemInstruction: buildUnifiedSystemInstruction({
        surface: 'skill',
        modelId: 'sonic-3.5',
        modelDisplayName: 'Sonic 3.5',
        upstreamProvider: 'gemini',
        upstreamModelId: 'gemini-3.1-flash-lite',
        surfaceInstruction: `Executing LOODY Skill "${skill.name}" (v${skill.version}, category: ${skill.category}). Follow the skill template strictly.`,
      }),
      prompt: `${prompt}${toolSection}`,
    });

    const reconciled = reconcileTokenRecord({
      providerReported: {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        cachedTokens: gen.cachedTokens,
      },
      fallbackInputText: prompt,
      fallbackOutputText: gen.text,
    });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO token_usage (
        id, user_id, conversation_id, model_id, provider, task_type,
        input_tokens, output_tokens, cached_tokens, accounting_type,
        estimated_cost_usd, usage_date, usage_month, created_at
      ) VALUES (?, ?, ?, 'sonic-3.5', 'gemini', 'skill', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      req.authUser!.id,
      skill.id,
      reconciled.inputTokens,
      reconciled.outputTokens,
      reconciled.cachedTokens,
      reconciled.accountingType,
      computeEstimatedCostUsd({
        provider: 'gemini',
        inputTokens: reconciled.inputTokens,
        outputTokens: reconciled.outputTokens,
        cachedTokens: reconciled.cachedTokens,
      }),
      now.slice(0, 10),
      now.slice(0, 7),
      now
    );

    res.json({
      ok: true,
      skillId: skill.id,
      skillVersion: skill.version,
      toolOutputs,
      output: gen.text,
      latencyMs: gen.latencyMs,
      tokens: reconciled,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Skill execution failed.' });
  }
});
