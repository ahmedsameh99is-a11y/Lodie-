import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  db,
  listAuditLogs,
  listFeatureFlags,
  mapRowToPublicUser,
  recordAuditLog,
} from '../db';
import { type AuthenticatedRequest, requireAuth, requireDeveloper } from '../middleware';
import { createRateLimiter } from '../security';

export const settingsRouter = Router();
const restoreLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10, scope: 'settings_restore' });

settingsRouter.patch('/preferences', requireAuth, (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    displayName: z.string().trim().min(2).max(60).optional(),
    language: z.enum(['en', 'ar']).optional(),
    theme: z.enum(['dark', 'light', 'system']).optional(),
    accentColor: z.enum(['emerald', 'teal', 'mint', 'slate']).optional(),
    fontSize: z.enum(['sm', 'md', 'lg']).optional(),
    density: z.enum(['comfortable', 'compact']).optional(),
    soundEnabled: z.boolean().optional(),
    reducedMotion: z.boolean().optional(),
    splashCompleted: z.boolean().optional(),
    defaultModelId: z.string().trim().min(1).max(60).optional(),
    allowFallback: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    emailNotifications: z.boolean().optional(),
    usageAlerts: z.boolean().optional(),
    chatStreaming: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid settings update.' });
    return;
  }

  const user = req.authUser!;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE users
    SET display_name = ?, language = ?, theme = ?, accent_color = ?, font_size = ?, density = ?,
        sound_enabled = ?, reduced_motion = ?, splash_completed = ?, default_model_id = ?,
        allow_fallback = ?, memory_enabled = ?, email_notifications = ?, usage_alerts = ?, chat_streaming = ?, updated_at = ?
    WHERE id = ?
  `).run(
    parsed.data.displayName ?? user.displayName,
    parsed.data.language ?? user.language,
    parsed.data.theme ?? user.theme,
    parsed.data.accentColor ?? user.accentColor,
    parsed.data.fontSize ?? user.fontSize,
    parsed.data.density ?? user.density,
    parsed.data.soundEnabled !== undefined ? (parsed.data.soundEnabled ? 1 : 0) : user.soundEnabled ? 1 : 0,
    parsed.data.reducedMotion !== undefined ? (parsed.data.reducedMotion ? 1 : 0) : user.reducedMotion ? 1 : 0,
    parsed.data.splashCompleted !== undefined ? (parsed.data.splashCompleted ? 1 : 0) : user.splashCompleted ? 1 : 0,
    parsed.data.defaultModelId ?? user.defaultModelId,
    parsed.data.allowFallback !== undefined ? (parsed.data.allowFallback ? 1 : 0) : user.allowFallback ? 1 : 0,
    parsed.data.memoryEnabled !== undefined ? (parsed.data.memoryEnabled ? 1 : 0) : user.memoryEnabled ? 1 : 0,
    parsed.data.emailNotifications !== undefined ? (parsed.data.emailNotifications ? 1 : 0) : user.emailNotifications ? 1 : 0,
    parsed.data.usageAlerts !== undefined ? (parsed.data.usageAlerts ? 1 : 0) : user.usageAlerts ? 1 : 0,
    parsed.data.chatStreaming !== undefined ? (parsed.data.chatStreaming ? 1 : 0) : user.chatStreaming ? 1 : 0,
    now,
    user.id
  );

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as Record<string, unknown>;
  res.json({ user: mapRowToPublicUser(updated) });
});

settingsRouter.get('/export', requireAuth, (req: AuthenticatedRequest, res) => {
  const userId = req.authUser!.id;
  const projects = db.prepare('SELECT * FROM projects WHERE user_id = ?').all(userId);
  const projectFiles = db
    .prepare(
      'SELECT id, project_id, name, mime_type, size_bytes, extracted_text, summary, file_category, created_at FROM project_files WHERE user_id = ?'
    )
    .all(userId);
  const conversations = db.prepare('SELECT * FROM conversations WHERE user_id = ?').all(userId);
  const messages = db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  const files = db
    .prepare(
      'SELECT id, name, mime_type, size_bytes, extracted_text, folder, tags_json, summary, file_category, created_at FROM workspace_files WHERE user_id = ?'
    )
    .all(userId);
  const memories = db
    .prepare('SELECT id, scope, project_id, category, content, source_type, approved, created_at, updated_at FROM user_memories WHERE user_id = ?')
    .all(userId);
  const skills = db
    .prepare('SELECT * FROM skills_registry WHERE owner_user_id = ? AND is_builtin = 0')
    .all(userId);
  const tasks = db.prepare('SELECT * FROM project_tasks WHERE user_id = ?').all(userId);
  const taskSubtasks = db.prepare('SELECT * FROM task_subtasks WHERE user_id = ?').all(userId);
  const taskMilestones = db.prepare('SELECT * FROM task_milestones WHERE user_id = ?').all(userId);
  const koreWorkspaces = db.prepare('SELECT * FROM kore_workspaces WHERE user_id = ?').all(userId);
  const koreFiles = db.prepare('SELECT * FROM kore_files WHERE user_id = ?').all(userId);
  const researchReports = db.prepare('SELECT * FROM research_reports WHERE user_id = ?').all(userId);

  recordAuditLog({
    actorUserId: userId,
    actorEmail: req.authUser!.email,
    action: 'user_data_exported',
    targetType: 'user',
    targetId: userId,
    outcome: 'success',
    detail: 'Exported full backup archive v1.0',
  });

  res.json({
    backupVersion: '1.0',
    exportedAt: new Date().toISOString(),
    user: req.authUser,
    projects,
    projectFiles,
    conversations,
    messages,
    files,
    memories,
    skills,
    tasks,
    taskSubtasks,
    taskMilestones,
    koreWorkspaces,
    koreFiles,
    researchReports,
  });
});

const restoreSchema = z.object({
  backupVersion: z.enum(['1.0']).optional().default('1.0'),
  projects: z.array(z.record(z.string(), z.unknown())).max(300).optional().default([]),
  projectFiles: z.array(z.record(z.string(), z.unknown())).max(500).optional().default([]),
  conversations: z.array(z.record(z.string(), z.unknown())).max(500).optional().default([]),
  messages: z.array(z.record(z.string(), z.unknown())).max(5000).optional().default([]),
  files: z.array(z.record(z.string(), z.unknown())).max(500).optional().default([]),
  memories: z.array(z.record(z.string(), z.unknown())).max(500).optional().default([]),
  skills: z.array(z.record(z.string(), z.unknown())).max(200).optional().default([]),
  tasks: z.array(z.record(z.string(), z.unknown())).max(500).optional().default([]),
  taskSubtasks: z.array(z.record(z.string(), z.unknown())).max(1500).optional().default([]),
  taskMilestones: z.array(z.record(z.string(), z.unknown())).max(1000).optional().default([]),
  koreWorkspaces: z.array(z.record(z.string(), z.unknown())).max(200).optional().default([]),
  koreFiles: z.array(z.record(z.string(), z.unknown())).max(1000).optional().default([]),
  researchReports: z.array(z.record(z.string(), z.unknown())).max(300).optional().default([]),
});

settingsRouter.post('/restore', requireAuth, restoreLimiter, (req: AuthenticatedRequest, res) => {
  const parsed = restoreSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid backup JSON structure.' });
    return;
  }

  const userId = req.authUser!.id;
  const now = new Date().toISOString();
  const data = parsed.data;

  const projectIdMap = new Map<string, string>();
  const convIdMap = new Map<string, string>();
  const taskIdMap = new Map<string, string>();
  const koreWsIdMap = new Map<string, string>();

  const counts = {
    projects: 0,
    projectFiles: 0,
    conversations: 0,
    messages: 0,
    files: 0,
    memories: 0,
    skills: 0,
    tasks: 0,
    koreWorkspaces: 0,
    koreFiles: 0,
    researchReports: 0,
  };

  function allocateOwnedId(table: string, ownerCol: string, rawId: string | undefined): { id: string; alreadyOwned: boolean } {
    if (rawId && rawId.trim().length > 0 && rawId.length <= 120) {
      const existing = db.prepare(`SELECT ${ownerCol} AS owner FROM ${table} WHERE id = ?`).get(rawId) as
        | { owner: string | null }
        | undefined;
      if (!existing) {
        return { id: rawId, alreadyOwned: false };
      }
      if (existing.owner === userId) {
        return { id: rawId, alreadyOwned: true };
      }
    }
    return { id: crypto.randomUUID(), alreadyOwned: false };
  }

  const runRestore = db.transaction(() => {
    for (const raw of data.projects) {
      const oldId = typeof raw.id === 'string' ? raw.id : '';
      const alloc = allocateOwnedId('projects', 'user_id', oldId || undefined);
      if (oldId) projectIdMap.set(oldId, alloc.id);
      if (alloc.alreadyOwned) continue;
      db.prepare(`
        INSERT INTO projects (id, user_id, name, description, instructions, preferred_model_id, enabled_tools_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        userId,
        String(raw.name ?? 'Restored Project').slice(0, 120),
        String(raw.description ?? '').slice(0, 1000),
        String(raw.instructions ?? '').slice(0, 8000),
        String(raw.preferred_model_id ?? raw.preferredModelId ?? 'sonic-3').slice(0, 60),
        typeof raw.enabled_tools_json === 'string'
          ? raw.enabled_tools_json
          : JSON.stringify(Array.isArray(raw.enabledTools) ? raw.enabledTools : []),
        String(raw.created_at ?? raw.createdAt ?? now),
        String(raw.updated_at ?? raw.updatedAt ?? now)
      );
      counts.projects++;
    }

    for (const raw of data.projectFiles) {
      const oldProjId = typeof raw.project_id === 'string' ? raw.project_id : typeof raw.projectId === 'string' ? raw.projectId : '';
      const mappedProjId = projectIdMap.get(oldProjId);
      if (!mappedProjId) continue;
      const alloc = allocateOwnedId('project_files', 'user_id', typeof raw.id === 'string' ? raw.id : undefined);
      if (alloc.alreadyOwned) continue;
      db.prepare(`
        INSERT INTO project_files (id, project_id, user_id, name, mime_type, size_bytes, extracted_text, summary, file_category, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        mappedProjId,
        userId,
        String(raw.name ?? 'restored-file.txt').slice(0, 180),
        String(raw.mime_type ?? raw.mimeType ?? 'text/plain').slice(0, 120),
        Math.max(0, Number(raw.size_bytes ?? raw.sizeBytes ?? 0)),
        String(raw.extracted_text ?? raw.extractedText ?? '').slice(0, 150_000),
        String(raw.summary ?? '').slice(0, 4000),
        String(raw.file_category ?? raw.fileCategory ?? 'text').slice(0, 40),
        String(raw.created_at ?? raw.createdAt ?? now)
      );
      counts.projectFiles++;
    }

    for (const raw of data.conversations) {
      const oldId = typeof raw.id === 'string' ? raw.id : '';
      const alloc = allocateOwnedId('conversations', 'user_id', oldId || undefined);
      if (oldId) convIdMap.set(oldId, alloc.id);
      if (alloc.alreadyOwned) continue;
      const oldProj = typeof raw.project_id === 'string' ? raw.project_id : typeof raw.projectId === 'string' ? raw.projectId : '';
      const mappedProj = oldProj ? projectIdMap.get(oldProj) ?? null : null;
      db.prepare(`
        INSERT INTO conversations (id, user_id, project_id, title, model_id, folder, pinned, archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        userId,
        mappedProj,
        String(raw.title ?? 'Restored Chat').slice(0, 160),
        String(raw.model_id ?? raw.modelId ?? 'sonic-3').slice(0, 60),
        String(raw.folder ?? '').slice(0, 80),
        raw.pinned ? 1 : 0,
        raw.archived ? 1 : 0,
        String(raw.created_at ?? raw.createdAt ?? now),
        String(raw.updated_at ?? raw.updatedAt ?? now)
      );
      counts.conversations++;
    }

    for (const raw of data.messages) {
      const oldConv = typeof raw.conversation_id === 'string' ? raw.conversation_id : typeof raw.conversationId === 'string' ? raw.conversationId : '';
      const mappedConv = convIdMap.get(oldConv);
      if (!mappedConv) continue;
      const alloc = allocateOwnedId('messages', 'user_id', typeof raw.id === 'string' ? raw.id : undefined);
      if (alloc.alreadyOwned) continue;
      const roleVal = raw.role === 'assistant' || raw.role === 'system' ? raw.role : 'user';
      db.prepare(`
        INSERT INTO messages (
          id, conversation_id, user_id, role, content, attachments_json, citations_json,
          model_id, provider, input_tokens, output_tokens, cached_tokens, token_accounting_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        mappedConv,
        userId,
        roleVal,
        String(raw.content ?? '').slice(0, 120_000),
        raw.attachments_json ? String(raw.attachments_json) : null,
        raw.citations_json ? String(raw.citations_json) : null,
        raw.model_id ? String(raw.model_id) : null,
        raw.provider ? String(raw.provider) : null,
        raw.input_tokens !== undefined && raw.input_tokens !== null ? Number(raw.input_tokens) : null,
        raw.output_tokens !== undefined && raw.output_tokens !== null ? Number(raw.output_tokens) : null,
        raw.cached_tokens !== undefined && raw.cached_tokens !== null ? Number(raw.cached_tokens) : null,
        raw.token_accounting_type ? String(raw.token_accounting_type) : null,
        String(raw.created_at ?? raw.createdAt ?? now)
      );
      counts.messages++;
    }

    for (const raw of data.files) {
      const alloc = allocateOwnedId('workspace_files', 'user_id', typeof raw.id === 'string' ? raw.id : undefined);
      if (alloc.alreadyOwned) continue;
      db.prepare(`
        INSERT INTO workspace_files (
          id, user_id, name, mime_type, size_bytes, extracted_text, folder, tags_json, summary, file_category, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        userId,
        String(raw.name ?? 'restored-doc.txt').slice(0, 180),
        String(raw.mime_type ?? raw.mimeType ?? 'text/plain').slice(0, 120),
        Math.max(0, Number(raw.size_bytes ?? raw.sizeBytes ?? 0)),
        String(raw.extracted_text ?? raw.extractedText ?? '').slice(0, 150_000),
        String(raw.folder ?? '').slice(0, 80),
        typeof raw.tags_json === 'string' ? raw.tags_json : JSON.stringify(Array.isArray(raw.tags) ? raw.tags : []),
        String(raw.summary ?? '').slice(0, 4000),
        String(raw.file_category ?? raw.fileCategory ?? 'text').slice(0, 40),
        String(raw.created_at ?? raw.createdAt ?? now)
      );
      counts.files++;
    }

    for (const raw of data.memories) {
      const alloc = allocateOwnedId('user_memories', 'user_id', typeof raw.id === 'string' ? raw.id : undefined);
      if (alloc.alreadyOwned) continue;
      const oldProj = typeof raw.project_id === 'string' ? raw.project_id : typeof raw.projectId === 'string' ? raw.projectId : '';
      const mappedProj = oldProj ? projectIdMap.get(oldProj) ?? null : null;
      const scopeRaw = String(raw.scope ?? 'user');
      const validScope = ['user', 'conversation', 'project', 'knowledge', 'task', 'operational'].includes(scopeRaw)
        ? scopeRaw
        : 'user';
      const catRaw = String(raw.category ?? 'fact');
      const validCat = ['preference', 'fact', 'instruction'].includes(catRaw) ? catRaw : 'fact';
      db.prepare(`
        INSERT INTO user_memories (id, user_id, project_id, scope, category, content, source_type, approved, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        userId,
        mappedProj,
        validScope,
        validCat,
        String(raw.content ?? '').slice(0, 2000),
        raw.source_type === 'extracted' ? 'extracted' : 'user_approved',
        raw.approved === 0 || raw.approved === false ? 0 : 1,
        String(raw.created_at ?? raw.createdAt ?? now),
        String(raw.updated_at ?? raw.updatedAt ?? now)
      );
      counts.memories++;
    }

    for (const raw of data.skills) {
      const alloc = allocateOwnedId('skills_registry', 'owner_user_id', typeof raw.id === 'string' ? raw.id : undefined);
      if (alloc.alreadyOwned) continue;
      const oldProj = typeof raw.project_id === 'string' ? raw.project_id : '';
      const mappedProj = oldProj ? projectIdMap.get(oldProj) ?? null : null;
      db.prepare(`
        INSERT INTO skills_registry (
          id, owner_user_id, project_id, name, version, description, category,
          input_schema_json, output_schema_json, allowed_tools_json, prompt_template,
          is_builtin, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        alloc.id,
        userId,
        mappedProj,
        String(raw.name ?? 'Restored Skill').slice(0, 80),
        /^\d+\.\d+\.\d+$/.test(String(raw.version ?? '')) ? String(raw.version) : '1.0.0',
        String(raw.description ?? 'Restored custom skill package').slice(0, 500),
        String(raw.category ?? 'Custom').slice(0, 50),
        typeof raw.input_schema_json === 'string' ? raw.input_schema_json : JSON.stringify(raw.inputSchema ?? { input: 'string' }),
        typeof raw.output_schema_json === 'string' ? raw.output_schema_json : JSON.stringify(raw.outputSchema ?? { result: 'string' }),
        typeof raw.allowed_tools_json === 'string' ? raw.allowed_tools_json : JSON.stringify(raw.allowedTools ?? []),
        String(raw.prompt_template ?? raw.promptTemplate ?? 'Analyze:\n\n{{input}}').slice(0, 6000),
        raw.enabled === 0 || raw.enabled === false ? 0 : 1,
        String(raw.created_at ?? raw.createdAt ?? now),
        String(raw.updated_at ?? raw.updatedAt ?? now)
      );
      counts.skills++;
    }

    for (const raw of data.tasks) {
      const oldId = typeof raw.id === 'string' ? raw.id : '';
      const alloc = allocateOwnedId('project_tasks', 'user_id', oldId || undefined);
      if (oldId) taskIdMap.set(oldId, alloc.id);
      if (alloc.alreadyOwned) continue;
      const oldProj = typeof raw.project_id === 'string' ? raw.project_id : '';
      const mappedProj = oldProj ? projectIdMap.get(oldProj) ?? null : null;
      db.prepare(`
        INSERT INTO project_tasks (
          id, user_id, project_id, title, description, status, priority, template_name, recurring_cron, due_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        userId,
        mappedProj,
        String(raw.title ?? 'Restored Task').slice(0, 140),
        String(raw.description ?? '').slice(0, 2000),
        ['active', 'paused', 'completed', 'archived'].includes(String(raw.status ?? '')) ? String(raw.status) : 'active',
        ['low', 'medium', 'high'].includes(String(raw.priority ?? '')) ? String(raw.priority) : 'medium',
        raw.template_name ? String(raw.template_name) : null,
        raw.recurring_cron ? String(raw.recurring_cron) : null,
        raw.due_at ? String(raw.due_at) : null,
        String(raw.created_at ?? raw.createdAt ?? now),
        String(raw.updated_at ?? raw.updatedAt ?? now)
      );
      counts.tasks++;
    }

    for (const raw of data.taskSubtasks) {
      const mappedTask = taskIdMap.get(String(raw.task_id ?? ''));
      if (!mappedTask) continue;
      const alloc = allocateOwnedId('task_subtasks', 'user_id', typeof raw.id === 'string' ? raw.id : undefined);
      if (alloc.alreadyOwned) continue;
      db.prepare(`
        INSERT INTO task_subtasks (id, task_id, user_id, title, completed, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(alloc.id, mappedTask, userId, String(raw.title ?? 'Subtask').slice(0, 200), raw.completed ? 1 : 0, Number(raw.sort_order ?? 0));
    }

    for (const raw of data.taskMilestones) {
      const mappedTask = taskIdMap.get(String(raw.task_id ?? ''));
      if (!mappedTask) continue;
      const alloc = allocateOwnedId('task_milestones', 'user_id', typeof raw.id === 'string' ? raw.id : undefined);
      if (alloc.alreadyOwned) continue;
      db.prepare(`
        INSERT INTO task_milestones (id, task_id, user_id, title, status, target_date)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        mappedTask,
        userId,
        String(raw.title ?? 'Milestone').slice(0, 200),
        raw.status === 'reached' ? 'reached' : 'pending',
        raw.target_date ? String(raw.target_date) : null
      );
    }

    for (const raw of data.koreWorkspaces) {
      const oldId = typeof raw.id === 'string' ? raw.id : '';
      const alloc = allocateOwnedId('kore_workspaces', 'user_id', oldId || undefined);
      if (oldId) koreWsIdMap.set(oldId, alloc.id);
      if (alloc.alreadyOwned) continue;
      const oldProj = typeof raw.project_id === 'string' ? raw.project_id : '';
      const mappedProj = oldProj ? projectIdMap.get(oldProj) ?? null : null;
      db.prepare(`
        INSERT INTO kore_workspaces (id, user_id, project_id, name, description, language, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        userId,
        mappedProj,
        String(raw.name ?? 'Restored Kore Workspace').slice(0, 80),
        String(raw.description ?? '').slice(0, 400),
        String(raw.language ?? 'typescript').slice(0, 30),
        String(raw.created_at ?? raw.createdAt ?? now),
        String(raw.updated_at ?? raw.updatedAt ?? now)
      );
      counts.koreWorkspaces++;
    }

    for (const raw of data.koreFiles) {
      const mappedWs = koreWsIdMap.get(String(raw.workspace_id ?? raw.workspaceId ?? ''));
      if (!mappedWs) continue;
      const safePath = String(raw.path ?? 'src/restored.ts').replace(/\\/g, '/').replace(/^\/+/, '').trim();
      if (!safePath || safePath.includes('..')) continue;
      db.prepare(`
        INSERT OR IGNORE INTO kore_files (id, workspace_id, user_id, path, language, content, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        mappedWs,
        userId,
        safePath.slice(0, 180),
        String(raw.language ?? 'typescript').slice(0, 30),
        String(raw.content ?? '').slice(0, 150_000),
        String(raw.updated_at ?? raw.updatedAt ?? now)
      );
      counts.koreFiles++;
    }

    for (const raw of data.researchReports) {
      const alloc = allocateOwnedId('research_reports', 'user_id', typeof raw.id === 'string' ? raw.id : undefined);
      if (alloc.alreadyOwned) continue;
      const oldProj = typeof raw.project_id === 'string' ? raw.project_id : '';
      const mappedProj = oldProj ? projectIdMap.get(oldProj) ?? null : null;
      db.prepare(`
        INSERT INTO research_reports (id, user_id, project_id, query, summary, findings_json, sources_json, groundings_available, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        alloc.id,
        userId,
        mappedProj,
        String(raw.query ?? 'Restored Research').slice(0, 400),
        String(raw.summary ?? '').slice(0, 20000),
        typeof raw.findings_json === 'string' ? raw.findings_json : JSON.stringify(raw.findings ?? []),
        typeof raw.sources_json === 'string' ? raw.sources_json : JSON.stringify(raw.sources ?? []),
        raw.groundings_available ? 1 : 0,
        String(raw.created_at ?? raw.createdAt ?? now)
      );
      counts.researchReports++;
    }
  });

  runRestore();

  recordAuditLog({
    actorUserId: userId,
    actorEmail: req.authUser!.email,
    action: 'user_data_restored',
    targetType: 'user',
    targetId: userId,
    outcome: 'success',
    detail: `Restored backup (${Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ') || '0 new items'})`,
  });

  res.json({ ok: true, restored: counts });
});

settingsRouter.get('/flags', (_req, res) => {
  res.json({ flags: listFeatureFlags() });
});

// Developer/Admin Console Endpoints (strictly protected by requireDeveloper)
settingsRouter.get('/admin/overview', requireDeveloper, (_req: AuthenticatedRequest, res) => {
  const users = db
    .prepare(
      'SELECT id, email, display_name, role, plan, daily_token_limit, monthly_token_limit, created_at FROM users ORDER BY created_at DESC LIMIT 50'
    )
    .all();
  const usageStats = db
    .prepare(
      'SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens, COALESCE(SUM(estimated_cost_usd), 0) AS totalCostUsd FROM token_usage'
    )
    .get() as { requests: number; totalTokens: number; totalCostUsd: number };

  res.json({
    users,
    usageStats,
    flags: listFeatureFlags(),
    auditLogs: listAuditLogs(60),
  });
});

settingsRouter.patch('/admin/flags/:key', requireDeveloper, (req: AuthenticatedRequest, res) => {
  const enabled = z.boolean().safeParse(req.body?.enabled);
  if (!enabled.success) {
    res.status(400).json({ error: 'Boolean enabled required.' });
    return;
  }
  const result = db
    .prepare('UPDATE feature_flags SET enabled = ? WHERE key = ?')
    .run(enabled.data ? 1 : 0, req.params.key);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Feature flag not found.' });
    return;
  }
  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'feature_flag_updated',
    targetType: 'feature_flag',
    targetId: String(req.params.key),
    outcome: 'success',
    detail: `Set enabled=${enabled.data}`,
  });
  res.json({ flags: listFeatureFlags() });
});

settingsRouter.patch('/admin/users/:id/quota', requireDeveloper, (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    dailyTokenLimit: z.number().int().min(0),
    monthlyTokenLimit: z.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid quota parameters.' });
    return;
  }
  const clampedDaily = Math.min(1_000_000, Math.max(0, parsed.data.dailyTokenLimit));
  const monthly = parsed.data.monthlyTokenLimit ?? clampedDaily * 20;

  const result = db
    .prepare('UPDATE users SET daily_token_limit = ?, monthly_token_limit = ?, updated_at = ? WHERE id = ?')
    .run(clampedDaily, monthly, new Date().toISOString(), req.params.id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'user_quota_updated',
    targetType: 'user',
    targetId: String(req.params.id),
    outcome: 'success',
    detail: `Updated daily limit=${clampedDaily}, monthly=${monthly}`,
  });

  res.json({ ok: true, dailyTokenLimit: clampedDaily, monthlyTokenLimit: monthly });
});
