import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth } from '../middleware';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

export const WORKFLOW_TEMPLATES = [
  {
    id: 'tpl_security_audit',
    name: 'Full-Stack Security Audit',
    priority: 'high' as const,
    description: 'Audit auth, RBAC, SQL queries, XSS sinks, and secret storage boundaries.',
    subtasks: [
      'Review auth middleware & token validation',
      'Audit SQL parameterized queries & path checks',
      'Verify error taxonomy & audit logging',
    ],
    milestones: ['Security Findings Report', 'Remediation Sign-off'],
  },
  {
    id: 'tpl_feature_launch',
    name: 'Feature Release Checklist',
    priority: 'medium' as const,
    description: 'End-to-end delivery from schema migration to automated QA verification.',
    subtasks: [
      'Write database migration & Zod validators',
      'Implement responsive LTR/RTL UI view',
      'Run unit tests & browser E2E checks',
    ],
    milestones: ['Backend API Ready', 'Production QA Passed'],
  },
  {
    id: 'tpl_research_synthesis',
    name: 'Weekly Market & Tech Digest',
    priority: 'low' as const,
    description: 'Recurring intelligence gathering across verified sources.',
    recurringCron: '0 9 * * 1',
    subtasks: ['Run live search queries', 'Cross-check conflicting claims', 'Export executive brief'],
    milestones: ['Sources Collected', 'Final Digest Published'],
  },
];

function hydrateTask(taskRow: Record<string, unknown>) {
  const id = String(taskRow.id);
  const subtasks = (
    db.prepare('SELECT * FROM task_subtasks WHERE task_id = ? ORDER BY sort_order ASC').all(id) as Array<
      Record<string, unknown>
    >
  ).map((s) => ({
    id: String(s.id),
    title: String(s.title),
    completed: Boolean(s.completed),
    sortOrder: Number(s.sort_order ?? 0),
  }));

  const milestones = (
    db.prepare('SELECT * FROM task_milestones WHERE task_id = ?').all(id) as Array<Record<string, unknown>>
  ).map((m) => ({
    id: String(m.id),
    title: String(m.title),
    status: (m.status === 'reached' ? 'reached' : 'pending') as 'pending' | 'reached',
    targetDate: m.target_date ? String(m.target_date) : null,
  }));

  return {
    id,
    userId: String(taskRow.user_id),
    projectId: taskRow.project_id ? String(taskRow.project_id) : null,
    title: String(taskRow.title),
    description: String(taskRow.description ?? ''),
    status: String(taskRow.status),
    priority: String(taskRow.priority),
    templateName: taskRow.template_name ? String(taskRow.template_name) : null,
    recurringCron: taskRow.recurring_cron ? String(taskRow.recurring_cron) : null,
    dueAt: taskRow.due_at ? String(taskRow.due_at) : null,
    subtasks,
    milestones,
    createdAt: String(taskRow.created_at),
    updatedAt: String(taskRow.updated_at),
  };
}

tasksRouter.get('/templates', (_req, res) => {
  res.json({ templates: WORKFLOW_TEMPLATES });
});

tasksRouter.get('/', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare("SELECT * FROM project_tasks WHERE user_id = ? AND status != 'archived' ORDER BY updated_at DESC")
    .all(req.authUser!.id) as Array<Record<string, unknown>>;
  res.json({ tasks: rows.map(hydrateTask) });
});

tasksRouter.post('/', (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(2000).optional().default(''),
    projectId: z.string().trim().nullable().optional(),
    priority: z.enum(['low', 'medium', 'high']).optional().default('medium'),
    templateName: z.string().trim().max(80).nullable().optional(),
    recurringCron: z.string().trim().max(64).nullable().optional(),
    dueAt: z.string().trim().max(40).nullable().optional(),
    subtasks: z.array(z.string().trim().min(1).max(200)).max(20).optional().default([]),
    milestones: z.array(z.string().trim().min(1).max(160)).max(10).optional().default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid task payload.' });
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
    INSERT INTO project_tasks (
      id, user_id, project_id, title, description, status, priority, template_name, recurring_cron, due_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    parsed.data.projectId ?? null,
    parsed.data.title,
    parsed.data.description,
    parsed.data.priority,
    parsed.data.templateName ?? null,
    parsed.data.recurringCron ?? null,
    parsed.data.dueAt ?? null,
    now,
    now
  );

  const insSub = db.prepare('INSERT INTO task_subtasks (id, task_id, user_id, title, completed, sort_order) VALUES (?, ?, ?, ?, 0, ?)');
  parsed.data.subtasks.forEach((st, idx) => insSub.run(crypto.randomUUID(), id, userId, st, idx));

  const insMile = db.prepare("INSERT INTO task_milestones (id, task_id, user_id, title, status, target_date) VALUES (?, ?, ?, ?, 'pending', NULL)");
  parsed.data.milestones.forEach((ms) => insMile.run(crypto.randomUUID(), id, userId, ms));

  recordAuditLog({
    actorUserId: userId,
    actorEmail: req.authUser!.email,
    action: 'task_created',
    targetType: 'task',
    targetId: id,
    outcome: 'success',
    detail: `Created task "${parsed.data.title}"`,
  });

  const row = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json({ task: hydrateTask(row) });
});

tasksRouter.patch('/:id', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM project_tasks WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }

  const schema = z.object({
    title: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task update.' });
    return;
  }

  db.prepare(`
    UPDATE project_tasks
    SET title = ?, description = ?, status = ?, priority = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    parsed.data.title ?? String(row.title),
    parsed.data.description ?? String(row.description ?? ''),
    parsed.data.status ?? String(row.status),
    parsed.data.priority ?? String(row.priority),
    new Date().toISOString(),
    req.params.id,
    req.authUser!.id
  );

  const updated = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ task: hydrateTask(updated) });
});

tasksRouter.post('/:id/duplicate', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM project_tasks WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }
  const orig = hydrateTask(row);
  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO project_tasks (id, user_id, project_id, title, description, status, priority, template_name, recurring_cron, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    newId,
    req.authUser!.id,
    orig.projectId,
    `${orig.title} (Copy)`.slice(0, 160),
    orig.description,
    orig.priority,
    orig.templateName,
    orig.recurringCron,
    orig.dueAt,
    now,
    now
  );
  const insSub = db.prepare('INSERT INTO task_subtasks (id, task_id, user_id, title, completed, sort_order) VALUES (?, ?, ?, ?, 0, ?)');
  orig.subtasks.forEach((s, i) => insSub.run(crypto.randomUUID(), newId, req.authUser!.id, s.title, i));

  const dupRow = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(newId) as Record<string, unknown>;
  res.status(201).json({ task: hydrateTask(dupRow) });
});

tasksRouter.patch('/:id/subtasks/:subId', (req: AuthenticatedRequest, res) => {
  const completed = Boolean(req.body?.completed);
  const result = db
    .prepare('UPDATE task_subtasks SET completed = ? WHERE id = ? AND task_id = ? AND user_id = ?')
    .run(completed ? 1 : 0, req.params.subId, req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Subtask not found.' });
    return;
  }
  db.prepare('UPDATE project_tasks SET updated_at = ? WHERE id = ? AND user_id = ?').run(
    new Date().toISOString(),
    req.params.id,
    req.authUser!.id
  );
  const updated = db
    .prepare('SELECT * FROM project_tasks WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown>;
  res.json({ task: hydrateTask(updated) });
});

tasksRouter.patch('/:id/milestones/:mileId', (req: AuthenticatedRequest, res) => {
  const status = req.body?.status === 'reached' ? 'reached' : 'pending';
  const result = db
    .prepare('UPDATE task_milestones SET status = ? WHERE id = ? AND task_id = ? AND user_id = ?')
    .run(status, req.params.mileId, req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Milestone not found.' });
    return;
  }
  const updated = db
    .prepare('SELECT * FROM project_tasks WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown>;
  res.json({ task: hydrateTask(updated) });
});

tasksRouter.delete('/:id', (req: AuthenticatedRequest, res) => {
  const result = db
    .prepare('DELETE FROM project_tasks WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }
  res.json({ ok: true });
});
