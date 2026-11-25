import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_PLAN_LIMITS } from '../src/shared/quotas';
import type {
  AuditLogEntry,
  BrandedModel,
  BuiltinTool,
  FeatureFlag,
  PublicUser,
} from '../src/shared/types';
import { decryptSecret } from './security';
import { resolveProviderCredentials } from './providers/catalog';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const DB_PATH = process.env.LOODY_DB_PATH
  ? path.resolve(process.env.LOODY_DB_PATH)
  : path.join(DATA_DIR, 'loody.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function ensureColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version
    )
  );

  const migrations: Array<{ version: number; name: string; sql: string }> = [
    {
      version: 1,
      name: 'initial_stage_one_schema',
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          plan TEXT NOT NULL DEFAULT 'free',
          language TEXT NOT NULL DEFAULT 'en',
          sound_enabled INTEGER NOT NULL DEFAULT 1,
          reduced_motion INTEGER NOT NULL DEFAULT 0,
          splash_completed INTEGER NOT NULL DEFAULT 0,
          default_model_id TEXT NOT NULL DEFAULT 'sonic-3',
          daily_token_limit INTEGER NOT NULL DEFAULT ${DEFAULT_PLAN_LIMITS.free.daily},
          monthly_token_limit INTEGER NOT NULL DEFAULT ${DEFAULT_PLAN_LIMITS.free.monthly},
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS password_resets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_registry (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          tier TEXT NOT NULL,
          required_plan TEXT NOT NULL,
          provider TEXT NOT NULL,
          upstream_model_id TEXT NOT NULL,
          description TEXT NOT NULL,
          speed_class TEXT NOT NULL,
          reasoning_level TEXT NOT NULL,
          context_limit INTEGER,
          input_modalities_json TEXT NOT NULL,
          output_modalities_json TEXT NOT NULL,
          supports_tools INTEGER NOT NULL DEFAULT 1,
          supports_streaming INTEGER NOT NULL DEFAULT 1,
          pricing_summary TEXT NOT NULL,
          availability TEXT NOT NULL DEFAULT 'awaiting_config',
          availability_reason TEXT NOT NULL DEFAULT '',
          thinking_preset TEXT,
          last_tested_at TEXT,
          encrypted_api_key TEXT,
          custom_base_url TEXT
        );

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          instructions TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          model_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          attachments_json TEXT,
          model_id TEXT,
          provider TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cached_tokens INTEGER,
          token_accounting_type TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS token_usage (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          conversation_id TEXT,
          model_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          accounting_type TEXT NOT NULL,
          estimated_cost_usd REAL NOT NULL DEFAULT 0,
          usage_date TEXT NOT NULL,
          usage_month TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_token_usage_user_date ON token_usage(user_id, usage_date);
        CREATE INDEX IF NOT EXISTS idx_token_usage_user_month ON token_usage(user_id, usage_month);

        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          endpoint_url TEXT NOT NULL,
          auth_type TEXT NOT NULL DEFAULT 'none',
          encrypted_auth_token TEXT,
          status TEXT NOT NULL DEFAULT 'awaiting_test',
          last_error TEXT,
          tools_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS mcp_approvals (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
          tool_name TEXT NOT NULL,
          arguments_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS builtin_tools (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          permission_level TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          input_example_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_integrations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          connector_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'awaiting_config',
          encrypted_token TEXT,
          account_label TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, connector_id)
        );

        CREATE TABLE IF NOT EXISTS feature_flags (
          key TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          stage TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          description TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          actor_user_id TEXT,
          actor_email TEXT,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT,
          outcome TEXT NOT NULL,
          detail TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `,
    },
    {
      version: 2,
      name: 'v2_firebase_themes_files_shares',
      sql: `
        CREATE TABLE IF NOT EXISTS project_files (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          extracted_text TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_files (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          extracted_text TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_shares (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          model_id TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          transcript TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `,
    },
    {
      version: 3,
      name: 'v3_memories_knowledge_rag_and_indexes',
      sql: `
        CREATE TABLE IF NOT EXISTS user_memories (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          scope TEXT NOT NULL DEFAULT 'user',
          category TEXT NOT NULL DEFAULT 'fact',
          content TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'user_approved',
          approved INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_memories_owner ON user_memories(user_id, scope, project_id, approved);

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_owner ON knowledge_chunks(user_id, project_id, source_id);

        CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, user_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_workspace_files_user ON workspace_files(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);
      `,
    },
    {
      version: 4,
      name: 'v4_phase2b_agents_skills_kore_research_creative',
      sql: `
        CREATE TABLE IF NOT EXISTS tool_execution_logs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tool_id TEXT NOT NULL,
          category TEXT NOT NULL,
          input_json TEXT NOT NULL DEFAULT '{}',
          output_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          approved_by_user INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tool_logs_user_created ON tool_execution_logs(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS skills_registry (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          version TEXT NOT NULL DEFAULT '1.0.0',
          description TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'General',
          input_schema_json TEXT NOT NULL DEFAULT '{}',
          output_schema_json TEXT NOT NULL DEFAULT '{}',
          allowed_tools_json TEXT NOT NULL DEFAULT '[]',
          prompt_template TEXT NOT NULL,
          is_builtin INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          goal TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'work',
          status TEXT NOT NULL DEFAULT 'queued',
          final_output TEXT NOT NULL DEFAULT '',
          total_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS agent_steps (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          title TEXT NOT NULL,
          depends_on_json TEXT NOT NULL DEFAULT '[]',
          tool_ids_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending',
          input_summary TEXT NOT NULL DEFAULT '',
          output_text TEXT NOT NULL DEFAULT '',
          approval_required INTEGER NOT NULL DEFAULT 0,
          approval_status TEXT NOT NULL DEFAULT 'none',
          duration_ms INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          step_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, step_order ASC);

        CREATE TABLE IF NOT EXISTS project_tasks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          priority TEXT NOT NULL DEFAULT 'medium',
          template_name TEXT,
          recurring_cron TEXT,
          due_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_tasks_user ON project_tasks(user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS task_subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS task_milestones (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          target_date TEXT
        );

        CREATE TABLE IF NOT EXISTS kore_workspaces (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          language TEXT NOT NULL DEFAULT 'typescript',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kore_files (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES kore_workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'typescript',
          content TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, path)
        );

        CREATE TABLE IF NOT EXISTS research_reports (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          query TEXT NOT NULL,
          summary TEXT NOT NULL,
          findings_json TEXT NOT NULL DEFAULT '[]',
          sources_json TEXT NOT NULL DEFAULT '[]',
          groundings_available INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS creative_assets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          duration_sec REAL,
          storage_rel_path TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS creative_projects (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          config_json TEXT NOT NULL DEFAULT '{}',
          output_rel_path TEXT,
          mime_type TEXT,
          duration_sec REAL,
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `,
    },
    {
      version: 5,
      name: 'v5_inbound_mcp_kore_reviews_agent_idempotency',
      sql: `
        CREATE TABLE IF NOT EXISTS mcp_server_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          token_prefix TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          allowed_tools_json TEXT NOT NULL DEFAULT '[]',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_used_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_server_tokens_user ON mcp_server_tokens(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS kore_reviews (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES kore_workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          instruction TEXT NOT NULL,
          target_path TEXT,
          summary TEXT NOT NULL,
          findings_json TEXT NOT NULL DEFAULT '[]',
          proposed_patch_json TEXT,
          applied INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_kore_reviews_ws ON kore_reviews(workspace_id, user_id, created_at DESC);
      `,
    },
    {
      version: 7,
      name: 'v7_multi_provider_telemetry',
      sql: `
        CREATE TABLE IF NOT EXISTS provider_health (
          provider TEXT PRIMARY KEY,
          circuit_state TEXT NOT NULL DEFAULT 'closed',
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          avg_latency_ms INTEGER,
          last_error_class TEXT,
          last_error TEXT,
          cooldown_until TEXT,
          last_checked_at TEXT,
          updated_at TEXT NOT NULL
        );
      `,
    },
  ];

  const insertMig = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );
  for (const mig of migrations) {
    if (!applied.has(mig.version)) {
      db.exec(mig.sql);
      insertMig.run(mig.version, mig.name, new Date().toISOString());
    }
  }

  // Idempotent column upgrades for existing databases
  ensureColumn('users', 'theme', "TEXT NOT NULL DEFAULT 'dark'");
  ensureColumn('users', 'accent_color', "TEXT NOT NULL DEFAULT 'emerald'");
  ensureColumn('users', 'font_size', "TEXT NOT NULL DEFAULT 'md'");
  ensureColumn('users', 'density', "TEXT NOT NULL DEFAULT 'comfortable'");
  ensureColumn('users', 'allow_fallback', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'memory_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'email_notifications', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'usage_alerts', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'chat_streaming', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'auth_provider', "TEXT NOT NULL DEFAULT 'password'");
  ensureColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'firebase_uid', 'TEXT');
  ensureColumn('users', 'session_version', 'INTEGER NOT NULL DEFAULT 1');

  ensureColumn('projects', 'preferred_model_id', "TEXT NOT NULL DEFAULT 'sonic-3'");
  ensureColumn('projects', 'enabled_tools_json', "TEXT NOT NULL DEFAULT '[]'");

  ensureColumn('conversations', 'folder', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('conversations', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('conversations', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('conversations', 'share_id', 'TEXT');

  ensureColumn('workspace_files', 'folder', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('workspace_files', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('workspace_files', 'summary', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('workspace_files', 'storage_rel_path', 'TEXT');
  ensureColumn('workspace_files', 'file_category', "TEXT NOT NULL DEFAULT 'text'");

  ensureColumn('project_files', 'storage_rel_path', 'TEXT');
  ensureColumn('project_files', 'file_category', "TEXT NOT NULL DEFAULT 'text'");
  ensureColumn('project_files', 'summary', "TEXT NOT NULL DEFAULT ''");

  ensureColumn('messages', 'citations_json', 'TEXT');
  ensureColumn('messages', 'upstream_model_id', 'TEXT');
  ensureColumn('messages', 'upstream_attribution', 'TEXT');
  ensureColumn('token_usage', 'task_type', "TEXT NOT NULL DEFAULT 'chat'");
  ensureColumn('token_usage', 'upstream_model_id', 'TEXT');
  ensureColumn('token_usage', 'upstream_attribution', 'TEXT');
  ensureColumn('token_usage', 'latency_ms', 'INTEGER');
  ensureColumn('token_usage', 'fallback_attempts', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('token_usage', 'error_class', 'TEXT');
  ensureColumn('model_registry', 'error_class', 'TEXT');
  ensureColumn('model_registry', 'avg_latency_ms', 'INTEGER');
  ensureColumn('model_registry', 'last_error_detail', 'TEXT');
  ensureColumn('agent_runs', 'idempotency_key', 'TEXT');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, pinned DESC, updated_at DESC);'
  );
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_idempotency ON agent_runs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;'
  );
}

export function evaluateProviderCredentials(params: {
  provider: string;
  hasEncryptedKey: boolean;
  customBaseUrl?: string | null;
}): { configured: boolean; configuredReason: string; missingReason: string } {
  const resolved = resolveProviderCredentials({
    provider: params.provider,
    hasEncryptedKey: params.hasEncryptedKey,
    customBaseUrl: params.customBaseUrl,
  });
  return {
    configured: resolved.configured,
    configuredReason: resolved.configuredReason,
    missingReason: resolved.missingReason,
  };
}

function seedDefaults() {
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
  const hasGroqKey = Boolean(process.env.GROQ_API_KEY?.trim());

  const models = [
    {
      id: 'sonic-3',
      display_name: 'Sonic 3',
      tier: 'free',
      required_plan: 'free',
      provider: 'groq',
      upstream_model_id: 'openai/gpt-oss-20b',
      description: 'Ultra-low latency everyday assistant calibrated for rapid drafting, translation, vision Q&A, and quick lookups.',
      speed_class: 'Ultra-Fast',
      reasoning_level: 'Standard',
      context_limit: 131072,
      input_modalities_json: JSON.stringify(['text', 'image']),
      output_modalities_json: JSON.stringify(['text']),
      supports_tools: 1,
      supports_streaming: 1,
      pricing_summary: 'Included in Free Tier (60,000 tokens/day cap)',
      availability: hasGroqKey ? 'connected' : 'awaiting_config',
      availability_reason: hasGroqKey
        ? 'Configured via server-side GROQ_API_KEY adapter (connectivity test pending)'
        : 'GROQ_API_KEY not configured on server',
      thinking_preset: 'MINIMAL',
    },
    {
      id: 'sonic-3.5',
      display_name: 'Sonic 3.5',
      tier: 'free',
      required_plan: 'free',
      provider: 'gemini',
      upstream_model_id: 'gemini-3.1-flash-lite',
      description: 'High-speed balanced general intelligence engine for coding, vision, structured analysis, and long-context chat.',
      speed_class: 'Fast',
      reasoning_level: 'High',
      context_limit: 1000000,
      input_modalities_json: JSON.stringify(['text', 'image']),
      output_modalities_json: JSON.stringify(['text']),
      supports_tools: 1,
      supports_streaming: 1,
      pricing_summary: 'Included in Free Tier (50,000 tokens/day cap)',
      availability: hasGeminiKey ? 'connected' : 'awaiting_config',
      availability_reason: hasGeminiKey
        ? 'Configured via server-side GEMINI_API_KEY adapter (connectivity test pending)'
        : 'GEMINI_API_KEY not configured on server',
      thinking_preset: 'LOW',
    },
    {
      id: 'lodie-5.5',
      display_name: 'LOODY 5.5',
      tier: 'premium',
      required_plan: 'free',
      provider: 'gemini',
      upstream_model_id: 'gemini-3.1-flash-lite',
      description: 'Flagship deep-reasoning workspace model configured for multi-step architecture, multimodal analysis, root-cause debugging, and security auditing.',
      speed_class: 'Deep Reasoning',
      reasoning_level: 'Deep',
      context_limit: 1000000,
      input_modalities_json: JSON.stringify(['text', 'image']),
      output_modalities_json: JSON.stringify(['text']),
      supports_tools: 1,
      supports_streaming: 1,
      pricing_summary: 'Included in Free Tier (35,000 tokens/day cap)',
      availability: hasGeminiKey ? 'connected' : 'awaiting_config',
      availability_reason: hasGeminiKey
        ? 'Configured via server-side GEMINI_API_KEY adapter (HIGH thinking preset; connectivity test pending)'
        : 'GEMINI_API_KEY not configured on server',
      thinking_preset: 'HIGH',
    },
    {
      id: 'fables-5.3',
      display_name: 'Fables 5.3',
      tier: 'premium',
      required_plan: 'free',
      provider: 'groq',
      upstream_model_id: 'openai/gpt-oss-120b',
      description: 'Editorial narrative, multimodal storytelling, and script synthesis engine tuned for rich Arabic and English prose.',
      speed_class: 'Balanced',
      reasoning_level: 'High',
      context_limit: 131072,
      input_modalities_json: JSON.stringify(['text', 'image']),
      output_modalities_json: JSON.stringify(['text']),
      supports_tools: 1,
      supports_streaming: 1,
      pricing_summary: 'Included in Free Tier (40,000 tokens/day cap)',
      availability: hasGroqKey ? 'connected' : 'awaiting_config',
      availability_reason: hasGroqKey
        ? 'Configured via server-side GROQ_API_KEY adapter (Arabic literary quality verified; connectivity test pending)'
        : 'GROQ_API_KEY not configured on server',
      thinking_preset: 'HIGH',
    },
    {
      id: 'loody-vision-1',
      display_name: 'LOODY Vision 1',
      tier: 'multimodal',
      required_plan: 'free',
      provider: 'gemini',
      upstream_model_id: 'gemini-3.1-flash-lite',
      description: 'Multimodal visual comprehension model for UI screenshots, diagrams, documents, and image-grounded reasoning.',
      speed_class: 'Balanced',
      reasoning_level: 'High',
      context_limit: 1000000,
      input_modalities_json: JSON.stringify(['text', 'image']),
      output_modalities_json: JSON.stringify(['text']),
      supports_tools: 1,
      supports_streaming: 1,
      pricing_summary: 'Included in Free Tier (35,000 tokens/day cap)',
      availability: hasGeminiKey ? 'connected' : 'awaiting_config',
      availability_reason: hasGeminiKey
        ? 'Configured via server-side GEMINI_API_KEY Multimodal adapter (connectivity test pending)'
        : 'GEMINI_API_KEY not configured on server',
      thinking_preset: 'LOW',
    },
  ];

  const upsertModel = db.prepare(`
    INSERT INTO model_registry (
      id, display_name, tier, required_plan, provider, upstream_model_id, description,
      speed_class, reasoning_level, context_limit, input_modalities_json, output_modalities_json,
      supports_tools, supports_streaming, pricing_summary, availability, availability_reason, thinking_preset
    ) VALUES (
      @id, @display_name, @tier, @required_plan, @provider, @upstream_model_id, @description,
      @speed_class, @reasoning_level, @context_limit, @input_modalities_json, @output_modalities_json,
      @supports_tools, @supports_streaming, @pricing_summary, @availability, @availability_reason, @thinking_preset
    )
    ON CONFLICT(id) DO NOTHING
  `);

  for (const m of models) {
    upsertModel.run(m);
  }

  // Idempotent Phase 0 migration: move Lodie 5.5 off quota-throttled/probe-changed candidates onto gemini-3.6-flash (HIGH thinking)
  const hasMigrationV6 = Boolean(
    db.prepare('SELECT 1 FROM schema_migrations WHERE version = 6').get()
  );
  if (!hasMigrationV6) {
    db.prepare(`
      UPDATE model_registry
      SET provider = 'gemini',
          upstream_model_id = 'gemini-3.6-flash',
          thinking_preset = 'HIGH',
          availability = ?,
          availability_reason = ?,
          last_tested_at = NULL,
          error_class = ?,
          avg_latency_ms = NULL,
          last_error_detail = NULL
      WHERE id = 'lodie-5.5'
    `).run(
      hasGeminiKey ? 'connected' : 'awaiting_config',
      hasGeminiKey
        ? 'Configured via server-side GEMINI_API_KEY adapter (HIGH thinking preset; connectivity test pending)'
        : 'GEMINI_API_KEY not configured on server',
      hasGeminiKey ? null : 'configuration_error'
    );
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      6,
      'v6_lodie_5_5_gemini_3_6_flash_high',
      new Date().toISOString()
    );
  }

  // Idempotent Five Identities migration: align display_name ('LOODY 5.5') and live-verified primary upstream routes cleanly
  const hasMigrationV8 = Boolean(
    db.prepare('SELECT 1 FROM schema_migrations WHERE version = 8').get()
  );
  if (!hasMigrationV8) {
    const updatePrimary = db.prepare(`
      UPDATE model_registry
      SET display_name = ?,
          provider = ?,
          upstream_model_id = ?,
          description = ?,
          context_limit = ?,
          pricing_summary = ?,
          thinking_preset = ?,
          availability = ?,
          availability_reason = ?,
          last_tested_at = NULL,
          error_class = ?,
          avg_latency_ms = NULL,
          last_error_detail = NULL
      WHERE id = ?
    `);
    for (const m of models) {
      updatePrimary.run(
        m.display_name,
        m.provider,
        m.upstream_model_id,
        m.description,
        m.context_limit,
        m.pricing_summary,
        m.thinking_preset,
        m.availability,
        m.availability_reason,
        m.availability === 'awaiting_config' ? 'configuration_error' : null,
        m.id
      );
    }
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      8,
      'v8_five_identities_and_upstream_metadata',
      new Date().toISOString()
    );
  }

  // Idempotent Phase 0.3 migration: heal stale mismatched backup authentication_error on primary Gemini models (e.g. loody-vision-1)
  const hasMigrationV9 = Boolean(
    db.prepare('SELECT 1 FROM schema_migrations WHERE version = 9').get()
  );
  if (!hasMigrationV9) {
    db.prepare(`
      UPDATE model_registry
      SET availability = ?,
          availability_reason = ?,
          error_class = NULL,
          last_error_detail = NULL
      WHERE id = 'loody-vision-1'
        AND provider = 'gemini'
        AND availability = 'authentication_error'
    `).run(
      hasGeminiKey ? 'connected' : 'awaiting_config',
      hasGeminiKey
        ? 'Configured via server-side GEMINI_API_KEY Multimodal adapter (connectivity test pending)'
        : 'GEMINI_API_KEY not configured on server'
    );
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      9,
      'v9_heal_mismatched_vision_auth_error',
      new Date().toISOString()
    );
  }

  // Idempotent Phase 0.3 Task 1 migration: align Gemini models onto live-verified gemini-3.1-flash-lite away from 20 RPD preview bottlenecks
  const hasMigrationV10 = Boolean(
    db.prepare('SELECT 1 FROM schema_migrations WHERE version = 10').get()
  );
  if (!hasMigrationV10) {
    const updateUpstream = db.prepare(`
      UPDATE model_registry
      SET provider = 'gemini',
          upstream_model_id = 'gemini-3.1-flash-lite',
          thinking_preset = ?,
          availability = ?,
          availability_reason = ?,
          error_class = NULL,
          last_error_detail = NULL
      WHERE id = ? AND provider = 'gemini'
    `);
    const connState = hasGeminiKey ? 'connected' : 'awaiting_config';
    const connReason = hasGeminiKey
      ? 'Configured via server-side GEMINI_API_KEY adapter (gemini-3.1-flash-lite; connectivity test pending)'
      : 'GEMINI_API_KEY not configured on server';
    updateUpstream.run('LOW', connState, connReason, 'sonic-3.5');
    updateUpstream.run('HIGH', connState, connReason, 'lodie-5.5');
    updateUpstream.run('LOW', connState, connReason, 'loody-vision-1');
    db.prepare("DELETE FROM provider_health WHERE provider = 'gemini' AND circuit_state = 'open'").run();
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      10,
      'v10_gemini_3_1_flash_lite_primary_rescue',
      new Date().toISOString()
    );
  }

  // Idempotent Phase 0.3 Task 3 & 4 migration: unlock all 5 models for Free tier, enable universal text+image parity, and upgrade legacy Free quota defaults
  const hasMigrationV11 = Boolean(
    db.prepare('SELECT 1 FROM schema_migrations WHERE version = 11').get()
  );
  if (!hasMigrationV11) {
    const updateModelParity = db.prepare(`
      UPDATE model_registry
      SET required_plan = 'free',
          input_modalities_json = ?,
          pricing_summary = ?
      WHERE id = ?
    `);
    for (const m of models) {
      updateModelParity.run(m.input_modalities_json, m.pricing_summary, m.id);
    }

    // Upgrade only quota limit columns for existing free-tier accounts still on legacy defaults (never mutate role or plan)
    db.prepare(`
      UPDATE users
      SET daily_token_limit = ?,
          monthly_token_limit = ?,
          updated_at = ?
      WHERE plan = 'free'
        AND daily_token_limit = 25000
        AND monthly_token_limit = 300000
    `).run(DEFAULT_PLAN_LIMITS.free.daily, DEFAULT_PLAN_LIMITS.free.monthly, new Date().toISOString());

    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      11,
      'v11_unlock_free_models_generous_quotas_and_vision',
      new Date().toISOString()
    );
  }

  // Reconcile credential availability WITHOUT overwriting probe-derived availability/latency/error_class.
  const existingModels = db
    .prepare(
      'SELECT id, provider, encrypted_api_key, custom_base_url, availability, last_tested_at, error_class FROM model_registry'
    )
    .all() as Array<{
    id: string;
    provider: string;
    encrypted_api_key: string | null;
    custom_base_url: string | null;
    availability: string;
    last_tested_at: string | null;
    error_class: string | null;
  }>;

  const setAwaitingConfig = db.prepare(
    "UPDATE model_registry SET availability = 'awaiting_config', availability_reason = ?, error_class = 'configuration_error' WHERE id = ?"
  );
  const setConfiguredUntested = db.prepare(
    "UPDATE model_registry SET availability = 'connected', availability_reason = ?, error_class = NULL, last_error_detail = NULL WHERE id = ?"
  );
  const healStaleUnavailable = db.prepare(
    "UPDATE model_registry SET availability = 'temporarily_unavailable', availability_reason = ? WHERE id = ?"
  );

  for (const row of existingModels) {
    if (row.availability === 'disabled') continue;
    const cred = evaluateProviderCredentials({
      provider: row.provider,
      hasEncryptedKey: Boolean(row.encrypted_api_key),
      customBaseUrl: row.custom_base_url,
    });

    if (!cred.configured) {
      // Never clobber a previously verified model status just because a temporary shell/test process lacks runtime env secrets.
      if (row.last_tested_at && process.env.LOODY_SERVER_RUNTIME !== '1') {
        continue;
      }
      if (row.availability !== 'awaiting_config' || row.error_class !== 'configuration_error') {
        setAwaitingConfig.run(cred.missingReason, row.id);
      }
      continue;
    }

    // Credentials exist: never clobber real probe-derived states ('operational', 'slow', 'temporarily_unavailable', 'authentication_error', 'error').
    if (row.availability === 'awaiting_config') {
      setConfiguredUntested.run(cred.configuredReason, row.id);
    } else if (row.availability === 'operational' && !row.last_tested_at) {
      // Never treat an untested row as verified operational
      setConfiguredUntested.run(cred.configuredReason, row.id);
    } else if (row.availability === 'operational' && row.error_class) {
      // Heal legacy rows where seedDefaults previously clobbered a failed probe back to 'operational'
      healStaleUnavailable.run(
        `Previous probe recorded ${row.error_class}; run health check to re-verify.`,
        row.id
      );
    }
  }

  const tools = [
    {
      id: 'utc_clock',
      name: 'UTC & Timezone Inspector',
      description: 'Returns exact ISO-8601 UTC and localized timestamps for scheduling and audit correlation.',
      permission_level: 'read_only',
      enabled: 1,
      input_example_json: JSON.stringify({ timezone: 'UTC' }),
    },
    {
      id: 'json_schema_validator',
      name: 'JSON Payload Validator',
      description: 'Validates JSON syntax and inspects top-level structure safely inside an isolated parser.',
      permission_level: 'compute',
      enabled: 1,
      input_example_json: JSON.stringify({ payload: '{"service":"loody","stage":2}' }),
    },
    {
      id: 'token_budget_estimator',
      name: 'Token Budget Estimator',
      description: 'Estimates approximate character-to-token budget for prompts prior to model dispatch.',
      permission_level: 'read_only',
      enabled: 1,
      input_example_json: JSON.stringify({ text: 'Analyze security architecture for multi-tenant SaaS.' }),
    },
    {
      id: 'regex_tester',
      name: 'Safe Regex Matcher',
      description: 'Tests bounded regular expressions against sample input strings with length guards.',
      permission_level: 'compute',
      enabled: 1,
      input_example_json: JSON.stringify({ pattern: '^[a-z0-9-]+$', sample: 'sonic-3' }),
    },
    {
      id: 'csv_stats_profiler',
      name: 'CSV Dataset Profiler',
      description: 'Computes row counts, columns, null counts, numeric min/max/mean inside an isolated deterministic parser.',
      permission_level: 'compute',
      enabled: 1,
      input_example_json: JSON.stringify({ csv: 'model,latency_ms,tokens\nsonic-3,420,1200\nlodie-5.5,1480,3400' }),
    },
    {
      id: 'js_ts_ast_static_check',
      name: 'TypeScript & Security Static Analyzer',
      description: 'Inspects TypeScript/JavaScript source for delimiter balance, dangerous sinks (eval/innerHTML), and complexity.',
      permission_level: 'compute',
      enabled: 1,
      input_example_json: JSON.stringify({ code: 'export function sum(a: number, b: number) { return a + b; }' }),
    },
    {
      id: 'url_text_extractor',
      name: 'SSRF-Safe URL Inspector',
      description: 'Fetches public HTTP/HTTPS web pages with link-local/metadata blocking and extracts readable plain text.',
      permission_level: 'read_only',
      enabled: 1,
      input_example_json: JSON.stringify({ url: 'https://example.com' }),
    },
    {
      id: 'gemini_web_search',
      name: 'Live Web Grounded Search',
      description: 'Queries Gemini Google Search grounding to retrieve real-time cited URLs and web evidence when enabled.',
      permission_level: 'read_only',
      enabled: 1,
      input_example_json: JSON.stringify({ query: 'TypeScript 5 release notes' }),
    },
    {
      id: 'project_task_creator',
      name: 'Persistent Task Creator (Approval Required)',
      description: 'Creates a tracked workspace task with milestones inside the database after explicit user approval.',
      permission_level: 'restricted',
      enabled: 1,
      input_example_json: JSON.stringify({ title: 'Audit API Rate Limiter', priority: 'high' }),
    },
  ];
  const upsertTool = db.prepare(`
    INSERT INTO builtin_tools (id, name, description, permission_level, enabled, input_example_json)
    VALUES (@id, @name, @description, @permission_level, @enabled, @input_example_json)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const tool of tools) {
    upsertTool.run(tool);
  }

  const builtinSkills = [
    {
      id: 'skill_security_code_review',
      name: 'Security & Architecture Code Review',
      version: '1.1.0',
      description: 'Audits source code for auth gaps, injection flaws, SSRF, secrets exposure, and maintainability fixes.',
      category: 'LOODY Kore',
      input_schema_json: JSON.stringify({ code: 'string', language: 'string' }),
      output_schema_json: JSON.stringify({ findings: 'array', summary: 'string' }),
      allowed_tools_json: JSON.stringify(['js_ts_ast_static_check']),
      prompt_template:
        'Perform a strict security and architecture code review on the provided code. List concrete vulnerabilities, severity levels, and minimal exact remediation code.\n\nInput:\n{{input}}',
    },
    {
      id: 'skill_deep_research_brief',
      name: 'Source-Verified Research Brief',
      version: '1.0.0',
      description: 'Synthesizes topic claims, verified evidence, open questions, and structured recommendations without fabricating sources.',
      category: 'Research',
      input_schema_json: JSON.stringify({ topic: 'string', focus: 'string' }),
      output_schema_json: JSON.stringify({ executiveSummary: 'string', keyClaims: 'array' }),
      allowed_tools_json: JSON.stringify(['gemini_web_search', 'url_text_extractor']),
      prompt_template:
        'Produce an evidence-backed research brief on the following topic. Explicitly distinguish verified facts from hypotheses.\n\nTopic:\n{{input}}',
    },
    {
      id: 'skill_dataset_kpi_analyzer',
      name: 'Dataset & CSV KPI Analyzer',
      version: '1.0.0',
      description: 'Profiles tabular CSV data, identifies anomalies, and derives quantitative conclusions.',
      category: 'Data Analysis',
      input_schema_json: JSON.stringify({ csv: 'string', question: 'string' }),
      output_schema_json: JSON.stringify({ statistics: 'object', insights: 'array' }),
      allowed_tools_json: JSON.stringify(['csv_stats_profiler', 'json_schema_validator']),
      prompt_template:
        'Analyze the dataset and tool profiling stats to answer the analytical question clearly.\n\nDataset & Question:\n{{input}}',
    },
    {
      id: 'skill_engineering_srs_writer',
      name: 'Production Engineering Spec (SRS)',
      version: '1.0.0',
      description: 'Converts a product goal into database tables, API contracts, security controls, and acceptance tests.',
      category: 'Work & Planning',
      input_schema_json: JSON.stringify({ productGoal: 'string', constraints: 'string' }),
      output_schema_json: JSON.stringify({ architecture: 'string', milestones: 'array' }),
      allowed_tools_json: JSON.stringify(['utc_clock', 'token_budget_estimator']),
      prompt_template:
        'Draft a complete technical engineering specification including data schema, REST endpoints, failure states, and QA checks.\n\nGoal:\n{{input}}',
    },
  ];
  const nowSkill = new Date().toISOString();
  const upsertSkill = db.prepare(`
    INSERT INTO skills_registry (
      id, owner_user_id, project_id, name, version, description, category,
      input_schema_json, output_schema_json, allowed_tools_json, prompt_template,
      is_builtin, enabled, created_at, updated_at
    ) VALUES (
      @id, NULL, NULL, @name, @version, @description, @category,
      @input_schema_json, @output_schema_json, @allowed_tools_json, @prompt_template,
      1, 1, @now, @now
    )
    ON CONFLICT(id) DO NOTHING
  `);
  for (const sk of builtinSkills) {
    upsertSkill.run({ ...sk, now: nowSkill });
  }

  const flags: Array<{ key: string; label: string; stage: 'stage_1' | 'stage_2'; enabled: number; description: string }> = [
    {
      key: 'stage1_streaming_chat',
      label: 'Real-Time Streaming Chat',
      stage: 'stage_1',
      enabled: 1,
      description: 'Server-sent event streaming with stop, regenerate, continue, and edit-resend controls.',
    },
    {
      key: 'stage1_mcp_governance',
      label: 'MCP Safety & Approval Gate',
      stage: 'stage_1',
      enabled: 1,
      description: 'Permission-checked MCP server discovery and explicit approval workflow.',
    },
    {
      key: 'stage2_loody_code',
      label: 'LOODY Kore Workspace',
      stage: 'stage_2',
      enabled: 1,
      description: 'Active Phase 2B: Isolated workspace files, AST/TS checker, architecture review, and diff patch applicator.',
    },
    {
      key: 'stage2_loody_work',
      label: 'LOODY Work Multi-Agent Orchestrator',
      stage: 'stage_2',
      enabled: 1,
      description: 'Active Phase 2B: DAG multi-agent planner, specialist agents, persistent tasks, and approval gates.',
    },
    {
      key: 'stage2_skills',
      label: 'LOODY Executable Skills Registry',
      stage: 'stage_2',
      enabled: 1,
      description: 'Active Phase 2B: Versioned skill packages with declared tool permissions, import/export, and execution.',
    },
    {
      key: 'stage2_files',
      label: 'LOODY Files & Document Pipeline',
      stage: 'stage_2',
      enabled: 1,
      description: 'Workspace document repository and text extraction pipeline.',
    },
  ];
  const upsertFlag = db.prepare(`
    INSERT INTO feature_flags (key, label, stage, enabled, description)
    VALUES (@key, @label, @stage, @enabled, @description)
    ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, description = excluded.description
  `);
  for (const f of flags) {
    upsertFlag.run(f);
  }
}

runMigrations();
seedDefaults();

export function mapRowToPublicUser(row: Record<string, unknown>): PublicUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as PublicUser['role'],
    plan: row.plan as PublicUser['plan'],
    language: row.language === 'ar' ? 'ar' : 'en',
    theme: row.theme === 'light' || row.theme === 'system' ? row.theme : 'dark',
    accentColor:
      row.accent_color === 'teal' || row.accent_color === 'mint' || row.accent_color === 'slate'
        ? row.accent_color
        : 'emerald',
    fontSize: row.font_size === 'sm' || row.font_size === 'lg' ? row.font_size : 'md',
    density: row.density === 'compact' ? 'compact' : 'comfortable',
    soundEnabled: Boolean(row.sound_enabled),
    reducedMotion: Boolean(row.reduced_motion),
    splashCompleted: Boolean(row.splash_completed),
    defaultModelId: String(row.default_model_id || 'sonic-3'),
    allowFallback: row.allow_fallback === undefined ? true : Boolean(row.allow_fallback),
    memoryEnabled: row.memory_enabled === undefined ? true : Boolean(row.memory_enabled),
    emailNotifications: row.email_notifications === undefined ? true : Boolean(row.email_notifications),
    usageAlerts: row.usage_alerts === undefined ? true : Boolean(row.usage_alerts),
    chatStreaming: row.chat_streaming === undefined ? true : Boolean(row.chat_streaming),
    authProvider: String(row.auth_provider ?? 'password'),
    emailVerified: Boolean(row.email_verified),
    dailyTokenLimit: Number(row.daily_token_limit),
    monthlyTokenLimit: Number(row.monthly_token_limit),
    createdAt: String(row.created_at),
  };
}

export function mapRowToBrandedModel(row: Record<string, unknown>): BrandedModel {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    tier: row.tier as BrandedModel['tier'],
    requiredPlan: row.required_plan as BrandedModel['requiredPlan'],
    provider: row.provider as BrandedModel['provider'],
    upstreamModelId: String(row.upstream_model_id),
    description: String(row.description),
    speedClass: row.speed_class as BrandedModel['speedClass'],
    reasoningLevel: row.reasoning_level as BrandedModel['reasoningLevel'],
    contextLimit: row.context_limit !== null ? Number(row.context_limit) : null,
    inputModalities: JSON.parse(String(row.input_modalities_json)),
    outputModalities: JSON.parse(String(row.output_modalities_json)),
    supportsTools: Boolean(row.supports_tools),
    supportsStreaming: Boolean(row.supports_streaming),
    pricingSummary: String(row.pricing_summary),
    availability: row.availability as BrandedModel['availability'],
    availabilityReason: String(row.availability_reason),
    lastTestedAt: row.last_tested_at ? String(row.last_tested_at) : null,
    thinkingPreset: row.thinking_preset ? (String(row.thinking_preset) as BrandedModel['thinkingPreset']) : undefined,
    errorClass: row.error_class ? (String(row.error_class) as BrandedModel['errorClass']) : null,
    avgLatencyMs: row.avg_latency_ms !== null && row.avg_latency_ms !== undefined ? Number(row.avg_latency_ms) : null,
    lastErrorDetail: row.last_error_detail ? String(row.last_error_detail) : null,
  };
}

export function getModelCredentials(modelId: string): {
  rowProvider?: string;
  apiKey?: string;
  baseUrl?: string;
} {
  const row = db
    .prepare('SELECT provider, encrypted_api_key, custom_base_url FROM model_registry WHERE id = ?')
    .get(modelId) as { provider: string | null; encrypted_api_key: string | null; custom_base_url: string | null } | undefined;
  if (!row) return {};
  let apiKey: string | undefined;
  if (row.encrypted_api_key) {
    try {
      apiKey = decryptSecret(row.encrypted_api_key);
    } catch {
      apiKey = undefined;
    }
  }
  return {
    rowProvider: row.provider ?? undefined,
    apiKey,
    baseUrl: row.custom_base_url ?? undefined,
  };
}

export function recordAuditLog(params: {
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  outcome: 'success' | 'denied' | 'error';
  detail: string;
}): void {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, actor_email, action, target_type, target_id, outcome, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    params.actorUserId,
    params.actorEmail,
    params.action,
    params.targetType,
    params.targetId ?? null,
    params.outcome,
    params.detail,
    new Date().toISOString()
  );
}

const TOOL_CATEGORY_MAP: Record<string, string> = {
  utc_clock: 'Time & Scheduling',
  json_schema_validator: 'Data & Parsing',
  token_budget_estimator: 'Token & Compute',
  regex_tester: 'Data & Parsing',
  csv_stats_profiler: 'Data Analysis',
  js_ts_ast_static_check: 'Coding & LOODY Kore',
  url_text_extractor: 'Research & Web',
  gemini_web_search: 'Research & Web',
  project_task_creator: 'Productivity & Tasks',
};

export function listBuiltinTools(): BuiltinTool[] {
  const rows = db.prepare('SELECT * FROM builtin_tools ORDER BY id ASC').all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const id = String(r.id);
    return {
      id,
      name: String(r.name),
      description: String(r.description),
      category: TOOL_CATEGORY_MAP[id] ?? 'Data & Parsing',
      permissionLevel: r.permission_level as BuiltinTool['permissionLevel'],
      enabled: Boolean(r.enabled),
      inputExample: JSON.parse(String(r.input_example_json)),
    };
  });
}

export function listFeatureFlags(): FeatureFlag[] {
  const rows = db.prepare('SELECT * FROM feature_flags ORDER BY stage ASC, key ASC').all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    key: String(r.key),
    label: String(r.label),
    stage: r.stage as FeatureFlag['stage'],
    enabled: Boolean(r.enabled),
    description: String(r.description),
  }));
}

export function listAuditLogs(limit = 50): AuditLogEntry[] {
  const rows = db
    .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
    actorEmail: r.actor_email ? String(r.actor_email) : null,
    action: String(r.action),
    targetType: String(r.target_type),
    targetId: r.target_id ? String(r.target_id) : null,
    outcome: r.outcome as AuditLogEntry['outcome'],
    detail: String(r.detail),
    createdAt: String(r.created_at),
  }));
}
