import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { computeEstimatedCostUsd, reconcileTokenRecord } from '../../src/shared/quotas';
import { db, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth } from '../middleware';
import { generateModelText } from '../providers';
import { createRateLimiter } from '../security';
import { runBuiltinToolById } from '../tools/engine';

export const koreRouter = Router();
koreRouter.use(requireAuth);
const koreReviewLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 25, scope: 'kore_review' });

function sanitizeWorkspacePath(rawPath: string): string {
  const cleaned = rawPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\0') || cleaned.length > 180) {
    throw new Error('Invalid file path inside isolated LOODY Kore workspace.');
  }
  return cleaned;
}

function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.html')) return 'html';
  if (lower.endsWith('.css')) return 'css';
  return 'markdown';
}

function mapReviewRow(r: Record<string, unknown>) {
  const patchRaw = r.proposed_patch_json ? String(r.proposed_patch_json) : '';
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    instruction: String(r.instruction),
    targetPath: r.target_path ? String(r.target_path) : null,
    summary: String(r.summary),
    findings: JSON.parse(String(r.findings_json || '[]')),
    proposedPatch: patchRaw ? JSON.parse(patchRaw) : null,
    applied: Boolean(r.applied),
    createdAt: String(r.created_at),
  };
}

koreRouter.get('/workspaces/:id/reviews', (req: AuthenticatedRequest, res) => {
  const ws = db
    .prepare('SELECT id FROM kore_workspaces WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id);
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found.' });
    return;
  }
  const rows = db
    .prepare('SELECT * FROM kore_reviews WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(req.params.id, req.authUser!.id) as Array<Record<string, unknown>>;
  res.json({ reviews: rows.map(mapReviewRow) });
});

koreRouter.post('/workspaces/:id/reviews/:reviewId/applied', (req: AuthenticatedRequest, res) => {
  const result = db
    .prepare('UPDATE kore_reviews SET applied = 1 WHERE id = ? AND workspace_id = ? AND user_id = ?')
    .run(req.params.reviewId, req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Review record not found.' });
    return;
  }
  res.json({ ok: true });
});

koreRouter.get('/workspaces', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(`
      SELECT w.*, COUNT(f.id) AS file_count
      FROM kore_workspaces w
      LEFT JOIN kore_files f ON f.workspace_id = w.id
      WHERE w.user_id = ?
      GROUP BY w.id
      ORDER BY w.updated_at DESC
    `)
    .all(req.authUser!.id) as Array<Record<string, unknown>>;

  res.json({
    workspaces: rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      projectId: r.project_id ? String(r.project_id) : null,
      name: String(r.name),
      description: String(r.description ?? ''),
      language: String(r.language ?? 'typescript'),
      fileCount: Number(r.file_count ?? 0),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    })),
  });
});

koreRouter.post('/workspaces', (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(400).optional().default(''),
    language: z.enum(['typescript', 'javascript', 'python', 'web']).optional().default('typescript'),
    projectId: z.string().trim().nullable().optional(),
    starterFiles: z.boolean().optional().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid workspace payload.' });
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

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO kore_workspaces (id, user_id, project_id, name, description, language, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, parsed.data.projectId ?? null, parsed.data.name, parsed.data.description, parsed.data.language, now, now);

  if (parsed.data.starterFiles) {
    const insFile = db.prepare(`
      INSERT INTO kore_files (id, workspace_id, user_id, path, language, content, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insFile.run(
      crypto.randomUUID(),
      id,
      userId,
      'src/index.ts',
      'typescript',
      `// LOODY Kore Workspace: ${parsed.data.name}\nexport interface ServiceConfig {\n  maxRetries: number;\n  timeoutMs: number;\n}\n\nexport function computeBackoffMs(attempt: number, config: ServiceConfig): number {\n  const clamped = Math.min(Math.max(0, attempt), config.maxRetries);\n  return Math.min(config.timeoutMs, 250 * Math.pow(2, clamped));\n}\n`,
      now
    );
    insFile.run(
      crypto.randomUUID(),
      id,
      userId,
      'README.md',
      'markdown',
      `# ${parsed.data.name}\n\n${parsed.data.description || 'Isolated code workspace managed by LOODY Kore.'}\n`,
      now
    );
  }

  recordAuditLog({
    actorUserId: userId,
    actorEmail: req.authUser!.email,
    action: 'kore_workspace_created',
    targetType: 'kore_workspace',
    targetId: id,
    outcome: 'success',
    detail: `Created workspace "${parsed.data.name}"`,
  });

  res.status(201).json({
    workspace: {
      id,
      userId,
      projectId: parsed.data.projectId ?? null,
      name: parsed.data.name,
      description: parsed.data.description,
      language: parsed.data.language,
      fileCount: parsed.data.starterFiles ? 2 : 0,
      createdAt: now,
      updatedAt: now,
    },
  });
});

koreRouter.delete('/workspaces/:id', (req: AuthenticatedRequest, res) => {
  const result = db
    .prepare('DELETE FROM kore_workspaces WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Workspace not found.' });
    return;
  }
  res.json({ ok: true });
});

koreRouter.get('/workspaces/:id/files', (req: AuthenticatedRequest, res) => {
  const ws = db
    .prepare('SELECT id FROM kore_workspaces WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id);
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found.' });
    return;
  }
  const files = db
    .prepare('SELECT * FROM kore_files WHERE workspace_id = ? AND user_id = ? ORDER BY path ASC')
    .all(req.params.id, req.authUser!.id) as Array<Record<string, unknown>>;

  res.json({
    files: files.map((f) => ({
      id: String(f.id),
      workspaceId: String(f.workspace_id),
      path: String(f.path),
      language: String(f.language),
      content: String(f.content),
      updatedAt: String(f.updated_at),
    })),
  });
});

koreRouter.put('/workspaces/:id/files', (req: AuthenticatedRequest, res) => {
  const ws = db
    .prepare('SELECT id FROM kore_workspaces WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id);
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found.' });
    return;
  }

  const schema = z.object({
    path: z.string().trim().min(1).max(180),
    content: z.string().max(150_000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid file update.' });
    return;
  }

  let safePath: string;
  try {
    safePath = sanitizeWorkspacePath(parsed.data.path);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid file path.' });
    return;
  }

  const lang = detectLanguage(safePath);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO kore_files (id, workspace_id, user_id, path, language, content, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, path) DO UPDATE SET
      language = excluded.language,
      content = excluded.content,
      updated_at = excluded.updated_at
  `).run(id, req.params.id, req.authUser!.id, safePath, lang, parsed.data.content, now);

  db.prepare('UPDATE kore_workspaces SET updated_at = ? WHERE id = ?').run(now, req.params.id);

  const row = db
    .prepare('SELECT * FROM kore_files WHERE workspace_id = ? AND path = ?')
    .get(req.params.id, safePath) as Record<string, unknown>;

  res.json({
    file: {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      path: String(row.path),
      language: String(row.language),
      content: String(row.content),
      updatedAt: String(row.updated_at),
    },
  });
});

koreRouter.delete('/workspaces/:id/files/:fileId', (req: AuthenticatedRequest, res) => {
  const result = db
    .prepare('DELETE FROM kore_files WHERE id = ? AND workspace_id = ? AND user_id = ?')
    .run(req.params.fileId, req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Workspace file not found.' });
    return;
  }
  res.json({ ok: true });
});

koreRouter.post('/workspaces/:id/check', async (req: AuthenticatedRequest, res) => {
  const ws = db
    .prepare('SELECT * FROM kore_workspaces WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found.' });
    return;
  }

  const files = db
    .prepare('SELECT path, language, content FROM kore_files WHERE workspace_id = ? AND user_id = ?')
    .all(req.params.id, req.authUser!.id) as Array<{ path: string; language: string; content: string }>;

  const report: Array<{
    path: string;
    language: string;
    passed: boolean;
    findings: Array<{ severity: string; message: string }>;
  }> = [];

  for (const f of files) {
    if (f.language === 'typescript' || f.language === 'javascript') {
      const check = await runBuiltinToolById({
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        toolId: 'js_ts_ast_static_check',
        input: { code: f.content },
      });
      const out = (check.output ?? {}) as {
        passed?: boolean;
        securityFindings?: Array<{ severity: string; message: string }>;
        syntaxDiagnostics?: string[];
      };
      const findings = [
        ...(out.securityFindings ?? []),
        ...(out.syntaxDiagnostics ?? []).map((msg) => ({ severity: 'high', message: `Syntax: ${msg}` })),
      ];
      report.push({
        path: f.path,
        language: f.language,
        passed: Boolean(out.passed ?? true) && findings.length === 0,
        findings,
      });
    } else if (f.language === 'json') {
      try {
        JSON.parse(f.content);
        report.push({ path: f.path, language: 'json', passed: true, findings: [] });
      } catch (err) {
        report.push({
          path: f.path,
          language: 'json',
          passed: false,
          findings: [{ severity: 'high', message: err instanceof Error ? err.message : 'Invalid JSON syntax' }],
        });
      }
    } else {
      report.push({
        path: f.path,
        language: f.language,
        passed: true,
        findings: [{ severity: 'info', message: 'Text/markup file inspected (no runtime compiler executed for this language).' }],
      });
    }
  }

  res.json({
    executionBoundary:
      'Static syntax, AST, JSON, and security-pattern verification only. Arbitrary OS shell command execution is disabled cleanly for sandbox isolation.',
    overallPassed: report.every((r) => r.passed),
    files: report,
  });
});

koreRouter.post('/workspaces/:id/review', koreReviewLimiter, async (req: AuthenticatedRequest, res) => {
  const ws = db
    .prepare('SELECT * FROM kore_workspaces WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!ws) {
    res.status(404).json({ error: 'Workspace not found.' });
    return;
  }

  const schema = z.object({
    instruction: z.string().trim().min(4).max(2000),
    targetPath: z.string().trim().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Review or refactoring instruction required.' });
    return;
  }

  const files = db
    .prepare('SELECT path, language, content FROM kore_files WHERE workspace_id = ? AND user_id = ? ORDER BY path ASC')
    .all(req.params.id, req.authUser!.id) as Array<{ path: string; language: string; content: string }>;

  if (files.length === 0) {
    res.status(400).json({ error: 'Add at least one file before invoking LOODY Kore review.' });
    return;
  }

  const filesContext = files
    .map((f) => `=== FILE: ${f.path} (${f.language}) ===\n${f.content.slice(0, 12000)}`)
    .join('\n\n');

  try {
    const gen = await generateModelText({
      upstreamModelId: 'gemini-4-hydrogen',
      thinkingPreset: 'HIGH',
      systemInstruction:
        'You are LOODY Kore, an elite software architect and security code reviewer. Analyze the provided isolated workspace files. Return valid JSON ONLY with keys: "summary" (string), "findings" (array of {severity, filePath, issue, fix}), and "proposedPatch" ({filePath, diffSummary, updatedContent} or null if no file edits requested).',
      prompt: `Workspace: ${ws.name}\nUser Instruction: ${parsed.data.instruction}\nTarget File Focus: ${
        parsed.data.targetPath ?? 'All workspace files'
      }\n\nWorkspace Files:\n${filesContext}`,
    });

    const reconciled = reconcileTokenRecord({
      providerReported: {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        cachedTokens: gen.cachedTokens,
      },
      fallbackInputText: filesContext,
      fallbackOutputText: gen.text,
    });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO token_usage (
        id, user_id, conversation_id, model_id, provider, task_type,
        input_tokens, output_tokens, cached_tokens, accounting_type,
        estimated_cost_usd, usage_date, usage_month, created_at
      ) VALUES (?, ?, ?, 'lodie-5.5', 'gemini', 'coding', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      req.authUser!.id,
      String(ws.id),
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

    let parsedReview: {
      summary: string;
      findings: Array<{ severity: string; filePath: string; issue: string; fix: string }>;
      proposedPatch: { filePath: string; diffSummary: string; updatedContent: string } | null;
    };

    try {
      const jsonMatch = /\{[\s\S]*\}/.exec(gen.text);
      parsedReview = JSON.parse(jsonMatch ? jsonMatch[0] : gen.text);
    } catch {
      parsedReview = {
        summary: gen.text,
        findings: [],
        proposedPatch: null,
      };
    }

    const reviewId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO kore_reviews (
        id, workspace_id, user_id, instruction, target_path, summary,
        findings_json, proposed_patch_json, applied, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      reviewId,
      String(ws.id),
      req.authUser!.id,
      parsed.data.instruction,
      parsed.data.targetPath ?? null,
      parsedReview.summary ?? '',
      JSON.stringify(parsedReview.findings ?? []),
      parsedReview.proposedPatch ? JSON.stringify(parsedReview.proposedPatch) : null,
      now
    );

    res.json({
      review: {
        id: reviewId,
        workspaceId: String(ws.id),
        instruction: parsed.data.instruction,
        targetPath: parsed.data.targetPath ?? null,
        applied: false,
        createdAt: now,
        ...parsedReview,
      },
      tokens: reconciled,
      latencyMs: gen.latencyMs,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'LOODY Kore analysis failed.' });
  }
});
