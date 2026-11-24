import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { buildUnifiedSystemInstruction, wrapUntrustedContext } from '../../src/shared/assistantPolicy';
import { computeEstimatedCostUsd } from '../../src/shared/quotas';
import { classifyFileCategory } from '../../src/shared/rag';
import { db, recordAuditLog } from '../db';
import {
  deleteKnowledgeSourceChunks,
  extractDocumentContent,
  indexKnowledgeSource,
  removeUserBinaryFile,
  resolveUserBinaryPath,
  runServerTextAnalysis,
  saveUserBinaryFile,
} from '../knowledge';
import { type AuthenticatedRequest, requireAuth } from '../middleware';
import { createRateLimiter, inspectUploadedBinarySafety } from '../security';

export const filesRouter = Router();

filesRouter.use(requireAuth);

const fileUploadLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30, scope: 'files_upload' });
const fileAiLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 25, scope: 'files_ai' });

function mapWorkspaceFile(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    name: String(r.name),
    mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes),
    extractedText: String(r.extracted_text ?? ''),
    folder: String(r.folder ?? ''),
    tags: r.tags_json ? (JSON.parse(String(r.tags_json)) as string[]) : [],
    summary: String(r.summary ?? ''),
    fileCategory: (r.file_category ? String(r.file_category) : classifyFileCategory(String(r.name), String(r.mime_type))) as
      | 'document'
      | 'spreadsheet'
      | 'image'
      | 'audio'
      | 'video'
      | 'code'
      | 'text',
    hasBinary: Boolean(r.storage_rel_path),
    createdAt: String(r.created_at),
  };
}

filesRouter.get('/', (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const folder = typeof req.query.folder === 'string' ? req.query.folder.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));

  let rows = db
    .prepare('SELECT * FROM workspace_files WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Array<Record<string, unknown>>;

  if (folder) {
    rows = rows.filter((r) => String(r.folder ?? '') === folder);
  }
  if (category) {
    rows = rows.filter((r) => String(r.file_category ?? 'text') === category);
  }
  if (q) {
    rows = rows.filter(
      (r) =>
        String(r.name).toLowerCase().includes(q) ||
        String(r.extracted_text).toLowerCase().includes(q) ||
        String(r.summary ?? '').toLowerCase().includes(q)
    );
  }

  const total = rows.length;
  const mapped = rows.slice(offset, offset + limit).map(mapWorkspaceFile);

  res.json({
    files: mapped,
    total,
  });
});

filesRouter.post('/', fileUploadLimiter, async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).max(160),
    mimeType: z.string().trim().min(1).max(140),
    sizeBytes: z.number().int().min(1).max(5_200_000),
    extractedText: z.string().max(150_000).optional().default(''),
    dataBase64: z.string().max(7_500_000).optional(),
    folder: z.string().trim().max(48).optional().default(''),
    tags: z.array(z.string().trim().max(32)).max(10).optional().default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid file upload payload.' });
    return;
  }

  let buffer: Buffer | undefined;
  if (parsed.data.dataBase64 !== undefined) {
    const normalized = parsed.data.dataBase64.replace(/\s+/g, '');
    if (!normalized) {
      res.status(400).json({ error: 'Empty (0-byte) files cannot be uploaded.' });
      return;
    }
    if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
      res.status(400).json({ error: 'Invalid base64 file payload.' });
      return;
    }
    buffer = Buffer.from(normalized, 'base64');
    if (buffer.length === 0) {
      res.status(400).json({ error: 'Empty (0-byte) files cannot be uploaded.' });
      return;
    }
    if (buffer.length > 5_200_000) {
      res.status(400).json({ error: 'Decoded file exceeds 5 MB upload ceiling.' });
      return;
    }
  } else if (parsed.data.extractedText) {
    buffer = Buffer.from(parsed.data.extractedText, 'utf8');
    if (buffer.length === 0) {
      res.status(400).json({ error: 'Empty (0-byte) files cannot be uploaded.' });
      return;
    }
  } else {
    res.status(400).json({ error: 'Empty (0-byte) files cannot be uploaded.' });
    return;
  }

  const safety = inspectUploadedBinarySafety({
    fileName: parsed.data.name,
    mimeType: parsed.data.mimeType,
    buffer,
  });
  if (!safety.safe) {
    res.status(400).json({ error: safety.reason ?? 'Disallowed or malformed file binary blocked by security policy.' });
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const userId = req.authUser!.id;

  const storageRelPath = buffer ? saveUserBinaryFile({ userId, fileId: id, buffer }) : null;
  try {
    const extracted = await extractDocumentContent({
      fileName: parsed.data.name,
      mimeType: parsed.data.mimeType,
      buffer,
      preExtractedText: parsed.data.extractedText,
    });

    db.prepare(`
      INSERT INTO workspace_files (
        id, user_id, name, mime_type, size_bytes, extracted_text,
        folder, tags_json, summary, storage_rel_path, file_category, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
    `).run(
      id,
      userId,
      parsed.data.name,
      parsed.data.mimeType,
      parsed.data.sizeBytes,
      extracted.extractedText,
      parsed.data.folder,
      JSON.stringify(parsed.data.tags),
      storageRelPath,
      extracted.fileCategory,
      now
    );

    if (extracted.extractedText.length > 10) {
      await indexKnowledgeSource({
        userId,
        sourceType: 'workspace_file',
        sourceId: id,
        projectId: null,
        title: parsed.data.name,
        text: extracted.extractedText,
        computeEmbeddings: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      });
    }

    recordAuditLog({
      actorUserId: userId,
      actorEmail: req.authUser!.email,
      action: 'workspace_file_uploaded',
      targetType: 'file',
      targetId: id,
      outcome: 'success',
      detail: `Uploaded ${parsed.data.name} (${extracted.fileCategory}, ${parsed.data.sizeBytes} bytes)`,
    });

    const row = db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(id) as Record<string, unknown>;
    res.status(201).json({ file: mapWorkspaceFile(row) });
  } catch (err) {
    removeUserBinaryFile(storageRelPath);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save uploaded file.' });
  }
});

filesRouter.patch('/:id', (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    folder: z.string().trim().max(48).optional(),
    tags: z.array(z.string().trim().max(32)).max(10).optional(),
    name: z.string().trim().min(1).max(160).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid file update payload.' });
    return;
  }

  const existing = db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }

  const folder = parsed.data.folder !== undefined ? parsed.data.folder : String(existing.folder ?? '');
  const tagsJson = parsed.data.tags !== undefined ? JSON.stringify(parsed.data.tags) : String(existing.tags_json ?? '[]');
  const name = parsed.data.name ?? String(existing.name);

  db.prepare('UPDATE workspace_files SET folder = ?, tags_json = ?, name = ? WHERE id = ? AND user_id = ?').run(
    folder,
    tagsJson,
    name,
    req.params.id,
    req.authUser!.id
  );

  const updated = db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ file: mapWorkspaceFile(updated) });
});

filesRouter.get('/:id/download', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }

  const safeName = String(row.name).replace(/["\r\n]/g, '_');
  const mime = String(row.mime_type || 'application/octet-stream');
  const inline = req.query.inline === '1';

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);

  const binPath = resolveUserBinaryPath(row.storage_rel_path ? String(row.storage_rel_path) : null);
  if (binPath) {
    res.sendFile(binPath);
    return;
  }
  res.send(Buffer.from(String(row.extracted_text ?? ''), 'utf8'));
});

filesRouter.post('/:id/summarize', fileAiLimiter, async (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }
  const text = String(row.extracted_text ?? '').trim();
  if (!text) {
    res.status(400).json({ error: 'No extracted text available in this file to summarize.' });
    return;
  }

  try {
    const analysis = await runServerTextAnalysis({
      instruction: buildUnifiedSystemInstruction({
        surface: 'file_analyst',
        modelId: 'sonic-3',
        modelDisplayName: 'Sonic 3',
        upstreamProvider: 'gemini',
        upstreamModelId: 'gemini-3.1-flash-lite',
        surfaceInstruction:
          'Produce a crisp executive summary with key takeaways, entities, and risks inside the uploaded document.',
      }),
      userPrompt: wrapUntrustedContext({
        kind: 'document',
        name: String(row.name),
        content: text,
        maxChars: 28_000,
      }),
    });

    db.prepare('UPDATE workspace_files SET summary = ? WHERE id = ? AND user_id = ?').run(
      analysis.text.slice(0, 4000),
      req.params.id,
      req.authUser!.id
    );

    const now = new Date().toISOString();
    const costUsd = computeEstimatedCostUsd({
      provider: 'gemini',
      inputTokens: analysis.inputTokens,
      outputTokens: analysis.outputTokens,
      cachedTokens: 0,
    });
    db.prepare(`
      INSERT INTO token_usage (
        id, user_id, conversation_id, model_id, provider, task_type, input_tokens, output_tokens,
        cached_tokens, accounting_type, estimated_cost_usd, usage_date, usage_month, created_at
      ) VALUES (?, ?, NULL, 'sonic-3', 'gemini', 'file_analysis', ?, ?, 0, 'provider_reported', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      req.authUser!.id,
      analysis.inputTokens,
      analysis.outputTokens,
      costUsd,
      now.slice(0, 10),
      now.slice(0, 7),
      now
    );

    const updated = db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json({ summary: analysis.text, file: mapWorkspaceFile(updated) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'File summarization failed.' });
  }
});

filesRouter.post('/:id/analyze', fileAiLimiter, async (req: AuthenticatedRequest, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 800) : '';
  if (!question) {
    res.status(400).json({ error: 'Provide an analysis prompt or question.' });
    return;
  }

  const row = db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }

  try {
    const analysis = await runServerTextAnalysis({
      instruction: buildUnifiedSystemInstruction({
        surface: 'file_analyst',
        modelId: 'sonic-3',
        modelDisplayName: 'Sonic 3',
        upstreamProvider: 'gemini',
        upstreamModelId: 'gemini-3.1-flash-lite',
        surfaceInstruction:
          'Answer the question strictly based on the attached document and cite relevant sections.',
      }),
      userPrompt: `Question: ${question}\n\n${wrapUntrustedContext({
        kind: 'document',
        name: String(row.name),
        content: String(row.extracted_text ?? ''),
        maxChars: 28_000,
      })}`,
    });

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO token_usage (
        id, user_id, conversation_id, model_id, provider, task_type, input_tokens, output_tokens,
        cached_tokens, accounting_type, estimated_cost_usd, usage_date, usage_month, created_at
      ) VALUES (?, ?, NULL, 'sonic-3', 'gemini', 'file_analysis', ?, ?, 0, 'provider_reported', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      req.authUser!.id,
      analysis.inputTokens,
      analysis.outputTokens,
      computeEstimatedCostUsd({
        provider: 'gemini',
        inputTokens: analysis.inputTokens,
        outputTokens: analysis.outputTokens,
        cachedTokens: 0,
      }),
      now.slice(0, 10),
      now.slice(0, 7),
      now
    );

    res.json({ analysis: analysis.text });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'File analysis failed.' });
  }
});

filesRouter.post('/compare', fileAiLimiter, async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    fileIdA: z.string().trim().min(1),
    fileIdB: z.string().trim().min(1),
    focus: z.string().trim().max(400).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Select two files to compare.' });
    return;
  }

  const fileA = db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND user_id = ?')
    .get(parsed.data.fileIdA, req.authUser!.id) as Record<string, unknown> | undefined;
  const fileB = db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND user_id = ?')
    .get(parsed.data.fileIdB, req.authUser!.id) as Record<string, unknown> | undefined;

  if (!fileA || !fileB) {
    res.status(404).json({ error: 'One or both selected files were not found.' });
    return;
  }

  try {
    const analysis = await runServerTextAnalysis({
      instruction: buildUnifiedSystemInstruction({
        surface: 'file_analyst',
        modelId: 'sonic-3',
        modelDisplayName: 'Sonic 3',
        upstreamProvider: 'gemini',
        upstreamModelId: 'gemini-3.1-flash-lite',
        surfaceInstruction:
          'Compare Document A and Document B clearly in markdown sections: Similarities, Key Differences, Contradictions/Gaps, and Recommendation.',
      }),
      userPrompt: `${parsed.data.focus ? `Focus: ${parsed.data.focus}\n\n` : ''}${wrapUntrustedContext({
        kind: 'document',
        name: `Document A: ${String(fileA.name)}`,
        content: String(fileA.extracted_text ?? ''),
        maxChars: 14_000,
      })}\n\n${wrapUntrustedContext({
        kind: 'document',
        name: `Document B: ${String(fileB.name)}`,
        content: String(fileB.extracted_text ?? ''),
        maxChars: 14_000,
      })}`,
    });

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO token_usage (
        id, user_id, conversation_id, model_id, provider, task_type, input_tokens, output_tokens,
        cached_tokens, accounting_type, estimated_cost_usd, usage_date, usage_month, created_at
      ) VALUES (?, ?, NULL, 'sonic-3', 'gemini', 'file_analysis', ?, ?, 0, 'provider_reported', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      req.authUser!.id,
      analysis.inputTokens,
      analysis.outputTokens,
      computeEstimatedCostUsd({
        provider: 'gemini',
        inputTokens: analysis.inputTokens,
        outputTokens: analysis.outputTokens,
        cachedTokens: 0,
      }),
      now.slice(0, 10),
      now.slice(0, 7),
      now
    );

    res.json({ comparison: analysis.text });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'File comparison failed.' });
  }
});

filesRouter.delete('/:id', (req: AuthenticatedRequest, res) => {
  const existing = db
    .prepare('SELECT storage_rel_path FROM workspace_files WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as { storage_rel_path?: string | null } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }
  db.prepare('DELETE FROM workspace_files WHERE id = ? AND user_id = ?').run(req.params.id, req.authUser!.id);
  deleteKnowledgeSourceChunks(req.authUser!.id, String(req.params.id));
  removeUserBinaryFile(existing.storage_rel_path);
  res.json({ ok: true });
});
