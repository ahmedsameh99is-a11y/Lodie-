import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { classifyFileCategory } from '../../src/shared/rag';
import { db } from '../db';
import {
  deleteKnowledgeSourceChunks,
  extractDocumentContent,
  indexKnowledgeSource,
  removeUserBinaryFile,
  resolveUserBinaryPath,
  saveUserBinaryFile,
} from '../knowledge';
import { type AuthenticatedRequest, requireAuth } from '../middleware';
import { createRateLimiter, inspectUploadedBinarySafety } from '../security';

export const projectsRouter = Router();

projectsRouter.use(requireAuth);
const projectFileLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30, scope: 'project_files' });

function mapProjectRow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    name: String(r.name),
    description: String(r.description),
    instructions: String(r.instructions),
    preferredModelId: String(r.preferred_model_id || 'sonic-3'),
    enabledTools: r.enabled_tools_json ? JSON.parse(String(r.enabled_tools_json)) : [],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    conversationCount: r.conversation_count !== undefined ? Number(r.conversation_count) : undefined,
    fileCount: r.file_count !== undefined ? Number(r.file_count) : undefined,
    memoryCount: r.memory_count !== undefined ? Number(r.memory_count) : undefined,
    lastActiveAt: r.last_active_at ? String(r.last_active_at) : null,
  };
}

projectsRouter.get('/', (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const rows = db
    .prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id AND c.user_id = p.user_id) AS conversation_count,
        (SELECT COUNT(*) FROM project_files pf WHERE pf.project_id = p.id AND pf.user_id = p.user_id) AS file_count,
        (SELECT COUNT(*) FROM user_memories um WHERE um.project_id = p.id AND um.user_id = p.user_id) AS memory_count,
        (SELECT MAX(c.updated_at) FROM conversations c WHERE c.project_id = p.id AND c.user_id = p.user_id) AS last_active_at
      FROM projects p
      WHERE p.user_id = ?
      ORDER BY p.updated_at DESC
    `)
    .all(userId) as Array<Record<string, unknown>>;

  res.json({
    projects: rows.map(mapProjectRow),
  });
});

const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional().default(''),
  instructions: z.string().trim().max(4000).optional().default(''),
  preferredModelId: z.string().trim().min(1).max(60).optional().default('sonic-3'),
  enabledTools: z.array(z.string().trim().max(64)).max(20).optional().default([]),
});

projectsRouter.post('/', (req: AuthenticatedRequest, res) => {
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid project payload.' });
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO projects (id, user_id, name, description, instructions, preferred_model_id, enabled_tools_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    req.authUser!.id,
    parsed.data.name,
    parsed.data.description,
    parsed.data.instructions,
    parsed.data.preferredModelId,
    JSON.stringify(parsed.data.enabledTools),
    now,
    now
  );

  res.status(201).json({
    project: {
      id,
      userId: req.authUser!.id,
      name: parsed.data.name,
      description: parsed.data.description,
      instructions: parsed.data.instructions,
      preferredModelId: parsed.data.preferredModelId,
      enabledTools: parsed.data.enabledTools,
      createdAt: now,
      updatedAt: now,
      conversationCount: 0,
      fileCount: 0,
      memoryCount: 0,
      lastActiveAt: null,
    },
  });
});

projectsRouter.patch('/:id', (req: AuthenticatedRequest, res) => {
  const parsed = projectSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid project update.' });
    return;
  }
  const existing = db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const now = new Date().toISOString();
  const name = parsed.data.name ?? String(existing.name);
  const description = parsed.data.description ?? String(existing.description);
  const instructions = parsed.data.instructions ?? String(existing.instructions);
  const preferredModelId = parsed.data.preferredModelId ?? String(existing.preferred_model_id || 'sonic-3');
  const enabledTools =
    parsed.data.enabledTools ??
    (existing.enabled_tools_json ? JSON.parse(String(existing.enabled_tools_json)) : []);

  db.prepare(
    'UPDATE projects SET name = ?, description = ?, instructions = ?, preferred_model_id = ?, enabled_tools_json = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).run(
    name,
    description,
    instructions,
    preferredModelId,
    JSON.stringify(enabledTools),
    now,
    req.params.id,
    req.authUser!.id
  );

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ project: mapProjectRow(row) });
});

projectsRouter.delete('/:id', (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const projectFiles = db
    .prepare('SELECT id, storage_rel_path FROM project_files WHERE project_id = ? AND user_id = ?')
    .all(req.params.id, userId) as Array<{ id: string; storage_rel_path: string | null }>;
  const projectMemories = db
    .prepare('SELECT id FROM user_memories WHERE project_id = ? AND user_id = ?')
    .all(req.params.id, userId) as Array<{ id: string }>;

  const result = db
    .prepare('DELETE FROM projects WHERE id = ? AND user_id = ?')
    .run(req.params.id, userId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  for (const pf of projectFiles) {
    removeUserBinaryFile(pf.storage_rel_path);
    deleteKnowledgeSourceChunks(userId, pf.id);
  }
  for (const mem of projectMemories) {
    deleteKnowledgeSourceChunks(userId, mem.id);
  }
  db.prepare('DELETE FROM knowledge_chunks WHERE user_id = ? AND project_id = ?').run(userId, req.params.id);

  res.json({ ok: true });
});

// Export full project bundle (metadata + files + project memories + linked conversations & turns)
projectsRouter.get('/:id/export', (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const proj = db
    .prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(req.params.id, userId) as Record<string, unknown> | undefined;
  if (!proj) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }

  const files = db
    .prepare('SELECT id, name, mime_type, size_bytes, extracted_text, created_at FROM project_files WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC')
    .all(req.params.id, userId);
  const memories = db
    .prepare('SELECT id, category, content, approved, created_at FROM user_memories WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC')
    .all(req.params.id, userId);
  const conversations = db
    .prepare('SELECT id, title, model_id, created_at, updated_at FROM conversations WHERE project_id = ? AND user_id = ? ORDER BY updated_at DESC')
    .all(req.params.id, userId) as Array<Record<string, unknown>>;

  const conversationsWithMessages = conversations.map((c) => {
    const messages = db
      .prepare('SELECT role, content, model_id, created_at FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC')
      .all(String(c.id), userId);
    return { ...c, messages };
  });

  res.json({
    exportedAt: new Date().toISOString(),
    project: mapProjectRow(proj),
    files,
    memories,
    conversations: conversationsWithMessages,
  });
});

// Project Knowledge Files
projectsRouter.get('/:id/files', (req: AuthenticatedRequest, res) => {
  const owns = db
    .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id);
  if (!owns) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  const rows = db
    .prepare('SELECT * FROM project_files WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC')
    .all(req.params.id, req.authUser!.id) as Array<Record<string, unknown>>;

  res.json({
    files: rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      userId: String(r.user_id),
      name: String(r.name),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      extractedText: String(r.extracted_text),
      fileCategory: r.file_category ? String(r.file_category) : classifyFileCategory(String(r.name), String(r.mime_type)),
      hasBinary: Boolean(r.storage_rel_path),
      createdAt: String(r.created_at),
    })),
  });
});

projectsRouter.post('/:id/files', projectFileLimiter, async (req: AuthenticatedRequest, res) => {
  const owns = db
    .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id);
  if (!owns) {
    res.status(404).json({ error: 'Project not found.' });
    return;
  }
  const schema = z.object({
    name: z.string().trim().min(1).max(160),
    mimeType: z.string().trim().min(1).max(140),
    sizeBytes: z.number().int().min(1).max(4_000_000),
    extractedText: z.string().max(120_000).optional().default(''),
    dataBase64: z.string().max(6_000_000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid project file payload.' });
    return;
  }

  let buffer: Buffer | undefined;
  if (parsed.data.dataBase64 !== undefined) {
    const cleanB64 = parsed.data.dataBase64.replace(/\s+/g, '');
    if (!cleanB64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleanB64) || cleanB64.length % 4 !== 0) {
      res.status(400).json({ error: 'Invalid base64 file payload.' });
      return;
    }
    buffer = Buffer.from(cleanB64, 'base64');
    if (buffer.length === 0) {
      res.status(400).json({ error: 'Empty (0-byte) files cannot be uploaded.' });
      return;
    }
    if (buffer.length > 4_000_000) {
      res.status(400).json({ error: 'Decoded project file exceeds 4 MB limit.' });
      return;
    }
  } else if (parsed.data.extractedText.length > 0) {
    buffer = Buffer.from(parsed.data.extractedText, 'utf8');
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
    res.status(400).json({ error: safety.reason ?? 'Disallowed file blocked by LOODY security policy.' });
    return;
  }
  const extracted = await extractDocumentContent({
    fileName: parsed.data.name,
    mimeType: parsed.data.mimeType,
    buffer,
    preExtractedText: parsed.data.extractedText,
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const userId = req.authUser!.id;
  const storageRelPath = buffer ? saveUserBinaryFile({ userId, fileId: id, buffer }) : null;

  const verifiedSizeBytes = buffer.length;
  try {
    db.prepare(`
      INSERT INTO project_files (id, project_id, user_id, name, mime_type, size_bytes, extracted_text, storage_rel_path, file_category, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      req.params.id,
      userId,
      parsed.data.name,
      parsed.data.mimeType,
      verifiedSizeBytes,
      extracted.extractedText,
      storageRelPath,
      extracted.fileCategory,
      now
    );
  } catch (dbErr) {
    removeUserBinaryFile(storageRelPath);
    throw dbErr;
  }

  if (extracted.extractedText.length > 10) {
    await indexKnowledgeSource({
      userId,
      sourceType: 'project_file',
      sourceId: id,
      projectId: String(req.params.id),
      title: parsed.data.name,
      text: extracted.extractedText,
      computeEmbeddings: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    });
  }

  res.status(201).json({
    file: {
      id,
      projectId: req.params.id,
      userId,
      name: parsed.data.name,
      mimeType: parsed.data.mimeType,
      sizeBytes: verifiedSizeBytes,
      extractedText: extracted.extractedText,
      fileCategory: extracted.fileCategory,
      hasBinary: Boolean(storageRelPath),
      createdAt: now,
    },
  });
});

projectsRouter.get('/:id/files/:fileId/download', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM project_files WHERE id = ? AND project_id = ? AND user_id = ?')
    .get(req.params.fileId, req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Project file not found.' });
    return;
  }

  const safeName = String(row.name).replace(/["\r\n]/g, '_');
  const rawMime = String(row.mime_type || 'application/octet-stream').toLowerCase();
  const isScriptable =
    /(html|svg|javascript|ecmascript|xhtml)/i.test(rawMime) || /\.(html?|svg|xhtml|mjs|js)$/i.test(safeName);
  const mime = isScriptable ? 'text/plain; charset=utf-8' : rawMime;
  const inline = req.query.inline === '1' && !isScriptable;

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

projectsRouter.delete('/:id/files/:fileId', (req: AuthenticatedRequest, res) => {
  const existing = db
    .prepare('SELECT storage_rel_path FROM project_files WHERE id = ? AND project_id = ? AND user_id = ?')
    .get(req.params.fileId, req.params.id, req.authUser!.id) as { storage_rel_path?: string | null } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'File not found.' });
    return;
  }
  db.prepare('DELETE FROM project_files WHERE id = ? AND project_id = ? AND user_id = ?').run(
    req.params.fileId,
    req.params.id,
    req.authUser!.id
  );
  deleteKnowledgeSourceChunks(req.authUser!.id, String(req.params.fileId));
  removeUserBinaryFile(existing.storage_rel_path);
  res.json({ ok: true });
});
