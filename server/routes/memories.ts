import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db, recordAuditLog } from '../db';
import { deleteKnowledgeSourceChunks, indexKnowledgeSource, retrieveKnowledgeCitations } from '../knowledge';
import { type AuthenticatedRequest, requireAuth } from '../middleware';

export const memoriesRouter = Router();

memoriesRouter.use(requireAuth);

const ALLOWED_SCOPES = new Set(['user', 'conversation', 'project', 'knowledge', 'task', 'operational']);

function mapMemoryRow(r: Record<string, unknown>) {
  const rawScope = String(r.scope ?? 'user');
  return {
    id: String(r.id),
    userId: String(r.user_id),
    projectId: r.project_id ? String(r.project_id) : null,
    scope: (ALLOWED_SCOPES.has(rawScope) ? rawScope : 'user') as
      | 'user'
      | 'conversation'
      | 'project'
      | 'knowledge'
      | 'task'
      | 'operational',
    category: (r.category === 'preference' || r.category === 'instruction' ? r.category : 'fact') as
      | 'preference'
      | 'fact'
      | 'instruction',
    content: String(r.content),
    sourceType: (r.source_type === 'extracted' ? 'extracted' : 'user_approved') as 'user_approved' | 'extracted',
    approved: Boolean(r.approved),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

memoriesRouter.get('/', (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const scope = typeof req.query.scope === 'string' ? req.query.scope : '';
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));

  let rows = db
    .prepare('SELECT * FROM user_memories WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as Array<Record<string, unknown>>;

  if (scope && ALLOWED_SCOPES.has(scope)) {
    rows = rows.filter((r) => r.scope === scope);
  }
  if (projectId) {
    rows = rows.filter((r) => r.project_id === projectId);
  }
  if (q) {
    rows = rows.filter((r) => String(r.content).toLowerCase().includes(q));
  }

  const total = rows.length;
  const paged = rows.slice(offset, offset + limit);

  const chunkAgg = db
    .prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE user_id = ?')
    .get(userId) as { count: number };

  res.json({
    memories: paged.map(mapMemoryRow),
    total,
    indexedChunkCount: Number(chunkAgg?.count ?? 0),
    memoryEnabled: req.authUser!.memoryEnabled,
  });
});

const createMemorySchema = z.object({
  scope: z.enum(['user', 'conversation', 'project', 'knowledge', 'task', 'operational']).optional().default('user'),
  projectId: z.string().trim().nullable().optional(),
  category: z.enum(['preference', 'fact', 'instruction']).optional().default('fact'),
  content: z.string().trim().min(2).max(1200),
  sourceType: z.enum(['user_approved', 'extracted']).optional().default('user_approved'),
  approved: z.boolean().optional().default(true),
});

memoriesRouter.post('/', async (req: AuthenticatedRequest, res) => {
  const parsed = createMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid memory payload.' });
    return;
  }

  const userId = req.authUser!.id;
  const projectId = parsed.data.scope === 'project' ? parsed.data.projectId ?? null : null;

  if (parsed.data.scope === 'project') {
    if (!projectId) {
      res.status(400).json({ error: 'Project ID is required for project-scoped memory.' });
      return;
    }
    const ownsProject = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
    if (!ownsProject) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_memories (id, user_id, project_id, scope, category, content, source_type, approved, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    projectId,
    parsed.data.scope,
    parsed.data.category,
    parsed.data.content,
    parsed.data.sourceType,
    parsed.data.approved ? 1 : 0,
    now,
    now
  );

  if (parsed.data.approved) {
    await indexKnowledgeSource({
      userId,
      sourceType: 'memory',
      sourceId: id,
      projectId,
      title: `${parsed.data.scope.toUpperCase()} Memory (${parsed.data.category})`,
      text: parsed.data.content,
      computeEmbeddings: false,
    });
  }

  recordAuditLog({
    actorUserId: userId,
    actorEmail: req.authUser!.email,
    action: 'memory_created',
    targetType: 'memory',
    targetId: id,
    outcome: 'success',
    detail: `Scope=${parsed.data.scope}, approved=${parsed.data.approved}`,
  });

  const row = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json({ memory: mapMemoryRow(row) });
});

memoriesRouter.patch('/:id', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    content: z.string().trim().min(2).max(1200).optional(),
    category: z.enum(['preference', 'fact', 'instruction']).optional(),
    approved: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid memory update.' });
    return;
  }

  const userId = req.authUser!.id;
  const existing = db
    .prepare('SELECT * FROM user_memories WHERE id = ? AND user_id = ?')
    .get(req.params.id, userId) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Memory not found.' });
    return;
  }

  const content = parsed.data.content ?? String(existing.content);
  const category = parsed.data.category ?? String(existing.category);
  const approved = parsed.data.approved !== undefined ? (parsed.data.approved ? 1 : 0) : Number(existing.approved);
  const now = new Date().toISOString();

  db.prepare('UPDATE user_memories SET content = ?, category = ?, approved = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    content,
    category,
    approved,
    now,
    req.params.id,
    userId
  );

  if (approved === 1) {
    await indexKnowledgeSource({
      userId,
      sourceType: 'memory',
      sourceId: String(req.params.id),
      projectId: existing.project_id ? String(existing.project_id) : null,
      title: existing.scope === 'project' ? `Project Memory (${category})` : `User Memory (${category})`,
      text: content,
      computeEmbeddings: false,
    });
  } else {
    deleteKnowledgeSourceChunks(userId, String(req.params.id));
  }

  const updated = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ memory: mapMemoryRow(updated) });
});

memoriesRouter.delete('/:id', (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const result = db
    .prepare('DELETE FROM user_memories WHERE id = ? AND user_id = ?')
    .run(req.params.id, userId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Memory not found.' });
    return;
  }
  deleteKnowledgeSourceChunks(userId, String(req.params.id));
  res.json({ ok: true });
});

memoriesRouter.post('/rag/search', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    query: z.string().trim().min(1).max(600),
    projectId: z.string().trim().nullable().optional(),
    topK: z.number().int().min(1).max(12).optional().default(5),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Query text is required.' });
    return;
  }

  const userId = req.authUser!.id;
  const projectId = parsed.data.projectId ?? null;
  if (projectId) {
    const ownsProject = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
    if (!ownsProject) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
  }

  const citations = await retrieveKnowledgeCitations({
    userId,
    projectId,
    query: parsed.data.query,
    topK: parsed.data.topK,
    allowEmbeddings: true,
  });

  const chunkAgg = db
    .prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE user_id = ?')
    .get(userId) as { count: number };

  res.json({
    citations,
    indexedChunkCount: Number(chunkAgg?.count ?? 0),
  });
});
