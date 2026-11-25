import type {
  AccentColor,
  AgentProfile,
  AgentRunRecord,
  AppLanguage,
  AppTheme,
  AuditLogEntry,
  BrandedModel,
  BuiltinTool,
  ChatAttachment,
  ChatMessage,
  Conversation,
  ConversationShare,
  CreativeAssetRecord,
  CreativeProjectRecord,
  DensityPref,
  DocumentAttachment,
  ErrorClass,
  FeatureFlag,
  FileCategory,
  FontSizePref,
  IntegrationConnector,
  KnowledgeCitation,
  KoreFileRecord,
  KoreReviewRecord,
  KoreWorkspaceRecord,
  MatrixRouteDescriptor,
  McpApprovalRequest,
  McpServerRecord,
  McpServerTokenRecord,
  MemoryScope,
  OrchestratorMode,
  PerModelDailyQuotaEntry,
  Project,
  ProjectFileRecord,
  ProviderStatusSummary,
  PublicUser,
  ResearchReport,
  SkillPackage,
  SpecialistAgentId,
  TokenUsageSummary,
  ToolExecutionLogEntry,
  UserMemory,
  VideoTimelineClip,
  WorkspaceFileRecord,
  WorkspaceTask,
} from '../shared/types';
import type {
  ChatStreamDoneEvent,
  ChatStreamErrorEventMeta,
  ChatStreamMetaEvent,
  ChatStreamStatusEvent,
} from '../shared/chatStream';
import { consumeSseReadableStream } from '../shared/chatStream';
import { getActiveFirebaseIdToken } from './firebase';

async function buildAuthHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = await getActiveFirebaseIdToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(message: string, opts: { status: number; code?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = await buildAuthHeaders(init?.headers);
  const resp = await fetch(url, {
    credentials: 'include',
    ...init,
    headers,
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    throw new ApiError(typeof data.error === 'string' ? data.error : `Request failed (${resp.status})`, {
      status: resp.status,
      code: typeof data.code === 'string' ? data.code : undefined,
      details: data,
    });
  }
  return data as T;
}

export const api = {
  getSession: () =>
    requestJson<{
      user: PublicUser | null;
      usage: {
        dailyUsed: number;
        dailyLimit?: number;
        dailyRemaining?: number;
        monthlyUsed: number;
        monthlyLimit?: number;
        monthlyRemaining?: number;
        dailyResetAtUtc?: string;
        monthlyResetAtUtc?: string;
        perModelDaily?: PerModelDailyQuotaEntry[];
      } | null;
    }>('/api/v1/auth/me'),

  firebaseExchange: (token: string) =>
    requestJson<{
      user: PublicUser;
      usage: {
        dailyUsed: number;
        dailyLimit?: number;
        dailyRemaining?: number;
        monthlyUsed: number;
        monthlyLimit?: number;
        monthlyRemaining?: number;
        dailyResetAtUtc?: string;
        monthlyResetAtUtc?: string;
        perModelDaily?: PerModelDailyQuotaEntry[];
      };
    }>('/api/v1/auth/firebase-exchange', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),

  register: (payload: { email: string; password: string; displayName: string; language?: AppLanguage }) =>
    requestJson<{
      user: PublicUser;
      usage: {
        dailyUsed: number;
        dailyLimit?: number;
        dailyRemaining?: number;
        monthlyUsed: number;
        monthlyLimit?: number;
        monthlyRemaining?: number;
        dailyResetAtUtc?: string;
        monthlyResetAtUtc?: string;
        perModelDaily?: PerModelDailyQuotaEntry[];
      };
    }>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  login: (payload: { email: string; password: string }) =>
    requestJson<{
      user: PublicUser;
      usage: {
        dailyUsed: number;
        dailyLimit?: number;
        dailyRemaining?: number;
        monthlyUsed: number;
        monthlyLimit?: number;
        monthlyRemaining?: number;
        dailyResetAtUtc?: string;
        monthlyResetAtUtc?: string;
        perModelDaily?: PerModelDailyQuotaEntry[];
      };
    }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  logout: () => requestJson<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST' }),

  requestPasswordReset: (email: string) =>
    requestJson<{ ok: boolean; emailRelayConfigured?: boolean; message: string }>(
      '/api/v1/auth/password-reset/request',
      {
        method: 'POST',
        body: JSON.stringify({ email }),
      }
    ),

  getAuthProvidersStatus: () =>
    requestJson<{
      firebaseConfigured: boolean;
      google: { configured: boolean; mode: string; message: string };
      apple: { configured: boolean; mode: string; message: string };
      emailPassword: { configured: boolean; firebaseEmailAuth: boolean };
    }>('/api/v1/auth/providers/status'),

  getGoogleAuthStatus: () =>
    requestJson<{ configured: boolean; status: string; message: string }>('/api/v1/auth/google/status'),

  deleteAccount: (password: string) =>
    requestJson<{ ok: boolean }>('/api/v1/auth/account', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    }),

  getModels: () => requestJson<{ models: BrandedModel[] }>('/api/v1/models'),

  checkModelsHealth: () =>
    requestJson<{
      checkedAt: string;
      results: Array<{
        id: string;
        displayName: string;
        ok: boolean;
        healthStatus: string;
        errorClass: ErrorClass | null;
        latencyMs: number;
        message: string;
      }>;
      models: BrandedModel[];
    }>('/api/v1/models/health-check', { method: 'POST' }),

  updateAdminModel: (id: string, payload: Record<string, unknown>) =>
    requestJson<{ model: BrandedModel }>(`/api/v1/models/admin/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  testAdminModel: (id: string) =>
    requestJson<{
      testResult: { ok: boolean; latencyMs: number; message: string; errorClass?: ErrorClass | null };
      model: BrandedModel;
    }>(`/api/v1/models/admin/${id}/test`, { method: 'POST' }),

  getModelMatrix: () =>
    requestJson<{
      providers: ProviderStatusSummary[];
      matrix: Record<string, MatrixRouteDescriptor[]>;
      unsupportedNotes: Array<{ provider: string; reason: string }>;
    }>('/api/v1/models/matrix'),

  testProviderEndpoint: (providerId: string) =>
    requestJson<{
      testResult: { ok: boolean; latencyMs: number; message: string; errorClass?: ErrorClass | null };
      provider: ProviderStatusSummary | null;
    }>(`/api/v1/models/providers/${providerId}/test`, { method: 'POST' }),

  resetProviderCircuitBreaker: (providerId: string) =>
    requestJson<{ provider: ProviderStatusSummary | null }>(`/api/v1/models/providers/${providerId}/reset-circuit`, {
      method: 'POST',
    }),

  getConversations: (params?: { q?: string; projectId?: string; folder?: string; archived?: '1' | 'all' }) => {
    const sp = new URLSearchParams();
    if (params?.q) sp.set('q', params.q);
    if (params?.projectId) sp.set('projectId', params.projectId);
    if (params?.folder) sp.set('folder', params.folder);
    if (params?.archived) sp.set('archived', params.archived);
    const qs = sp.toString();
    return requestJson<{ conversations: Conversation[] }>(`/api/v1/conversations${qs ? `?${qs}` : ''}`);
  },

  createConversation: (payload: {
    title?: string;
    modelId?: string;
    projectId?: string | null;
    folder?: string;
    pinned?: boolean;
  }) =>
    requestJson<{ conversation: Conversation }>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateConversation: (
    id: string,
    payload: {
      title?: string;
      modelId?: string;
      projectId?: string | null;
      folder?: string;
      pinned?: boolean;
      archived?: boolean;
    }
  ) =>
    requestJson<{ conversation: Conversation }>(`/api/v1/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteConversation: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/conversations/${id}`, { method: 'DELETE' }),

  clearConversations: (archivedOnly = false) =>
    requestJson<{ ok: boolean; deletedCount: number }>('/api/v1/conversations/clear', {
      method: 'POST',
      body: JSON.stringify({ archivedOnly }),
    }),

  shareConversation: (id: string) =>
    requestJson<{ shareId: string; shareUrl: string }>(`/api/v1/conversations/${id}/share`, {
      method: 'POST',
    }),

  unshareConversation: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/conversations/${id}/share`, {
      method: 'DELETE',
    }),

  getShareSnapshot: (shareId: string) =>
    requestJson<{ share: ConversationShare }>(`/api/v1/shares/${shareId}`),

  getMessages: (conversationId: string) =>
    requestJson<{ messages: ChatMessage[] }>(`/api/v1/conversations/${conversationId}/messages`),

  getProjects: () => requestJson<{ projects: Project[] }>('/api/v1/projects'),

  createProject: (payload: {
    name: string;
    description: string;
    instructions: string;
    preferredModelId?: string;
    enabledTools?: string[];
  }) =>
    requestJson<{ project: Project }>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateProject: (
    id: string,
    payload: Partial<{
      name: string;
      description: string;
      instructions: string;
      preferredModelId: string;
      enabledTools: string[];
    }>
  ) =>
    requestJson<{ project: Project }>(`/api/v1/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteProject: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/projects/${id}`, { method: 'DELETE' }),

  exportProjectBundle: (id: string) =>
    requestJson<{
      exportedAt: string;
      project: Project;
      files: Array<Record<string, unknown>>;
      memories: Array<Record<string, unknown>>;
      conversations: Array<Record<string, unknown>>;
    }>(`/api/v1/projects/${id}/export`),

  getProjectFiles: (projectId: string) =>
    requestJson<{ files: ProjectFileRecord[] }>(`/api/v1/projects/${projectId}/files`),

  uploadProjectFile: (
    projectId: string,
    payload: { name: string; mimeType: string; sizeBytes: number; extractedText?: string; dataBase64?: string }
  ) =>
    requestJson<{ file: ProjectFileRecord }>(`/api/v1/projects/${projectId}/files`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteProjectFile: (projectId: string, fileId: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/projects/${projectId}/files/${fileId}`, {
      method: 'DELETE',
    }),

  getProjectFileDownloadUrl: (projectId: string, fileId: string, inline = false) =>
    `/api/v1/projects/${projectId}/files/${fileId}/download${inline ? '?inline=1' : ''}`,

  getFiles: (params?: { q?: string; folder?: string; category?: FileCategory | '' }) => {
    const sp = new URLSearchParams();
    if (params?.q) sp.set('q', params.q);
    if (params?.folder) sp.set('folder', params.folder);
    if (params?.category) sp.set('category', params.category);
    const qs = sp.toString();
    return requestJson<{ files: WorkspaceFileRecord[]; total?: number }>(
      `/api/v1/files${qs ? `?${qs}` : ''}`
    );
  },

  uploadFile: (payload: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    extractedText?: string;
    dataBase64?: string;
    folder?: string;
    tags?: string[];
  }) =>
    requestJson<{ file: WorkspaceFileRecord }>('/api/v1/files', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateFile: (id: string, payload: { folder?: string; tags?: string[]; name?: string }) =>
    requestJson<{ file: WorkspaceFileRecord }>(`/api/v1/files/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  getFileDownloadUrl: (id: string, inline = false) =>
    `/api/v1/files/${id}/download${inline ? '?inline=1' : ''}`,

  summarizeFile: (id: string) =>
    requestJson<{ summary: string; file: WorkspaceFileRecord }>(`/api/v1/files/${id}/summarize`, {
      method: 'POST',
    }),

  analyzeFile: (id: string, question: string) =>
    requestJson<{ analysis: string }>(`/api/v1/files/${id}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),

  compareFiles: (fileIdA: string, fileIdB: string, focus?: string) =>
    requestJson<{ comparison: string }>('/api/v1/files/compare', {
      method: 'POST',
      body: JSON.stringify({ fileIdA, fileIdB, focus }),
    }),

  deleteFile: (id: string) => requestJson<{ ok: boolean }>(`/api/v1/files/${id}`, { method: 'DELETE' }),

  getMemories: (params?: { scope?: MemoryScope; projectId?: string; q?: string }) => {
    const sp = new URLSearchParams();
    if (params?.scope) sp.set('scope', params.scope);
    if (params?.projectId) sp.set('projectId', params.projectId);
    if (params?.q) sp.set('q', params.q);
    const qs = sp.toString();
    return requestJson<{
      memories: UserMemory[];
      total: number;
      indexedChunkCount: number;
      memoryEnabled: boolean;
    }>(`/api/v1/memories${qs ? `?${qs}` : ''}`);
  },

  createMemory: (payload: {
    scope: MemoryScope;
    projectId?: string | null;
    category: 'preference' | 'fact' | 'instruction';
    content: string;
    approved?: boolean;
  }) =>
    requestJson<{ memory: UserMemory }>('/api/v1/memories', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateMemory: (
    id: string,
    payload: { content?: string; category?: 'preference' | 'fact' | 'instruction'; approved?: boolean }
  ) =>
    requestJson<{ memory: UserMemory }>(`/api/v1/memories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteMemory: (id: string) => requestJson<{ ok: boolean }>(`/api/v1/memories/${id}`, { method: 'DELETE' }),

  searchRag: (payload: { query: string; projectId?: string | null; topK?: number }) =>
    requestJson<{ citations: KnowledgeCitation[]; indexedChunkCount: number }>('/api/v1/memories/rag/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getMcpServers: () => requestJson<{ servers: McpServerRecord[] }>('/api/v1/mcp/servers'),

  createMcpServer: (payload: {
    name: string;
    endpointUrl: string;
    authType: 'none' | 'bearer' | 'header';
    authToken?: string;
  }) =>
    requestJson<{ server: McpServerRecord }>('/api/v1/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  discoverMcpTools: (serverId: string) =>
    requestJson<{ status: string; tools: McpServerRecord['tools'] }>(`/api/v1/mcp/servers/${serverId}/discover`, {
      method: 'POST',
    }),

  disconnectMcpServer: (serverId: string) =>
    requestJson<{ ok: boolean; status: string }>(`/api/v1/mcp/servers/${serverId}/disconnect`, {
      method: 'POST',
    }),

  deleteMcpServer: (serverId: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/mcp/servers/${serverId}`, { method: 'DELETE' }),

  getMcpApprovals: () => requestJson<{ approvals: McpApprovalRequest[] }>('/api/v1/mcp/approvals'),

  decideMcpApproval: (approvalId: string, decision: 'approved' | 'rejected') =>
    requestJson<{ ok: boolean; status: string }>(`/api/v1/mcp/approvals/${approvalId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

  executeMcpTool: (payload: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    approvalId?: string;
  }) =>
    requestJson<{
      requiresApproval?: boolean;
      approvalId?: string;
      reason?: string;
      untrustedOutput?: boolean;
      securityNotice?: string;
      status?: number;
      output?: string;
    }>('/api/v1/mcp/execute', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getBuiltinTools: () => requestJson<{ tools: BuiltinTool[] }>('/api/v1/mcp/builtin-tools'),

  toggleBuiltinTool: (id: string, enabled: boolean) =>
    requestJson<{ tools: BuiltinTool[] }>(`/api/v1/mcp/builtin-tools/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  executeBuiltinTool: (id: string, input: Record<string, unknown>, approvedByUser = false) =>
    requestJson<{
      ok?: boolean;
      requiresApproval?: boolean;
      reason?: string;
      toolId?: string;
      durationMs?: number;
      output?: unknown;
    }>(`/api/v1/mcp/builtin-tools/${id}/execute`, {
      method: 'POST',
      body: JSON.stringify({ input, approvedByUser }),
    }),

  getToolLogs: () => requestJson<{ logs: ToolExecutionLogEntry[] }>('/api/v1/mcp/tool-logs'),

  getMcpServerTokens: () => requestJson<{ tokens: McpServerTokenRecord[] }>('/api/v1/mcp/server-tokens'),

  createMcpServerToken: (payload: { label: string; allowedTools: string[] }) =>
    requestJson<{ tokenRecord: McpServerTokenRecord; plainToken: string }>('/api/v1/mcp/server-tokens', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  toggleMcpServerToken: (id: string, enabled: boolean) =>
    requestJson<{ tokenRecord: McpServerTokenRecord }>(`/api/v1/mcp/server-tokens/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  deleteMcpServerToken: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/mcp/server-tokens/${id}`, { method: 'DELETE' }),

  // Phase 2B: Multi-Agent Orchestrator
  getAgentProfiles: () => requestJson<{ agents: AgentProfile[] }>('/api/v1/agents/profiles'),

  getAgentRuns: () => requestJson<{ runs: AgentRunRecord[] }>('/api/v1/agents/runs'),

  getAgentRun: (id: string) => requestJson<{ run: AgentRunRecord }>(`/api/v1/agents/runs/${id}`),

  startAgentRun: (payload: {
    goal: string;
    projectId?: string | null;
    mode?: OrchestratorMode;
    agents?: SpecialistAgentId[];
    requireApprovalForWrite?: boolean;
    idempotencyKey?: string;
  }) =>
    requestJson<{ run: AgentRunRecord; deduplicated?: boolean }>('/api/v1/agents/runs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  approveAgentStep: (runId: string, stepId: string, decision: 'approved' | 'rejected') =>
    requestJson<{ run: AgentRunRecord }>(`/api/v1/agents/runs/${runId}/approve-step/${stepId}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),

  pauseAgentRun: (runId: string) =>
    requestJson<{ run: AgentRunRecord }>(`/api/v1/agents/runs/${runId}/pause`, { method: 'POST' }),

  resumeAgentRun: (runId: string) =>
    requestJson<{ run: AgentRunRecord }>(`/api/v1/agents/runs/${runId}/resume`, { method: 'POST' }),

  cancelAgentRun: (runId: string) =>
    requestJson<{ run: AgentRunRecord }>(`/api/v1/agents/runs/${runId}/cancel`, { method: 'POST' }),

  // Phase 2B: Skills Engine
  getSkills: () => requestJson<{ skills: SkillPackage[] }>('/api/v1/skills'),

  createSkill: (payload: {
    name: string;
    version?: string;
    description: string;
    category?: string;
    projectId?: string | null;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    allowedTools?: string[];
    promptTemplate: string;
  }) =>
    requestJson<{ skill: SkillPackage }>('/api/v1/skills', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateSkill: (
    id: string,
    payload: {
      enabled?: boolean;
      name?: string;
      category?: string;
      allowedTools?: string[];
      version?: string;
      description?: string;
      promptTemplate?: string;
    }
  ) =>
    requestJson<{ skill: SkillPackage }>(`/api/v1/skills/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteSkill: (id: string) => requestJson<{ ok: boolean }>(`/api/v1/skills/${id}`, { method: 'DELETE' }),

  executeSkill: (id: string, input: string | Record<string, unknown>) =>
    requestJson<{
      ok: boolean;
      skillId: string;
      skillVersion: string;
      toolOutputs: Array<{ toolId: string; ok: boolean; data: unknown }>;
      output: string;
      latencyMs: number;
    }>(`/api/v1/skills/${id}/execute`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),

  // Phase 2B: Persistent Tasks & Workflow Templates
  getTaskTemplates: () =>
    requestJson<{
      templates: Array<{
        id: string;
        name: string;
        priority: 'low' | 'medium' | 'high';
        description: string;
        recurringCron?: string;
        subtasks: string[];
        milestones: string[];
      }>;
    }>('/api/v1/tasks/templates'),

  getTasks: () => requestJson<{ tasks: WorkspaceTask[] }>('/api/v1/tasks'),

  createTask: (payload: {
    title: string;
    description?: string;
    projectId?: string | null;
    priority?: 'low' | 'medium' | 'high';
    templateName?: string | null;
    recurringCron?: string | null;
    dueAt?: string | null;
    subtasks?: string[];
    milestones?: string[];
  }) =>
    requestJson<{ task: WorkspaceTask }>('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateTask: (
    id: string,
    payload: { title?: string; description?: string; status?: WorkspaceTask['status']; priority?: WorkspaceTask['priority'] }
  ) =>
    requestJson<{ task: WorkspaceTask }>(`/api/v1/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  duplicateTask: (id: string) =>
    requestJson<{ task: WorkspaceTask }>(`/api/v1/tasks/${id}/duplicate`, { method: 'POST' }),

  toggleSubtask: (taskId: string, subId: string, completed: boolean) =>
    requestJson<{ task: WorkspaceTask }>(`/api/v1/tasks/${taskId}/subtasks/${subId}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed }),
    }),

  toggleMilestone: (taskId: string, mileId: string, status: 'pending' | 'reached') =>
    requestJson<{ task: WorkspaceTask }>(`/api/v1/tasks/${taskId}/milestones/${mileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  deleteTask: (id: string) => requestJson<{ ok: boolean }>(`/api/v1/tasks/${id}`, { method: 'DELETE' }),

  // Phase 2B: LOODY Kore Workspaces
  getKoreWorkspaces: () => requestJson<{ workspaces: KoreWorkspaceRecord[] }>('/api/v1/kore/workspaces'),

  createKoreWorkspace: (payload: {
    name: string;
    description?: string;
    language?: 'typescript' | 'javascript' | 'python' | 'web';
    projectId?: string | null;
    starterFiles?: boolean;
  }) =>
    requestJson<{ workspace: KoreWorkspaceRecord }>('/api/v1/kore/workspaces', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteKoreWorkspace: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/kore/workspaces/${id}`, { method: 'DELETE' }),

  getKoreFiles: (workspaceId: string) =>
    requestJson<{ files: KoreFileRecord[] }>(`/api/v1/kore/workspaces/${workspaceId}/files`),

  saveKoreFile: (workspaceId: string, payload: { path: string; content: string }) =>
    requestJson<{ file: KoreFileRecord }>(`/api/v1/kore/workspaces/${workspaceId}/files`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  deleteKoreFile: (workspaceId: string, fileId: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/kore/workspaces/${workspaceId}/files/${fileId}`, {
      method: 'DELETE',
    }),

  checkKoreWorkspace: (workspaceId: string) =>
    requestJson<{
      executionBoundary: string;
      overallPassed: boolean;
      files: Array<{
        path: string;
        language: string;
        passed: boolean;
        findings: Array<{ severity: string; message: string }>;
      }>;
    }>(`/api/v1/kore/workspaces/${workspaceId}/check`, { method: 'POST' }),

  reviewKoreWorkspace: (workspaceId: string, payload: { instruction: string; targetPath?: string }) =>
    requestJson<{
      review: {
        id: string;
        summary: string;
        findings: Array<{ severity: string; filePath: string; issue: string; fix: string }>;
        proposedPatch: { filePath: string; diffSummary: string; updatedContent: string } | null;
      };
      latencyMs: number;
    }>(`/api/v1/kore/workspaces/${workspaceId}/review`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getKoreReviews: (workspaceId: string) =>
    requestJson<{ reviews: KoreReviewRecord[] }>(`/api/v1/kore/workspaces/${workspaceId}/reviews`),

  markKoreReviewApplied: (workspaceId: string, reviewId: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/kore/workspaces/${workspaceId}/reviews/${reviewId}/applied`, {
      method: 'POST',
    }),

  // Phase 2B: Research Engine
  getResearchReports: () => requestJson<{ reports: ResearchReport[] }>('/api/v1/research/reports'),

  deleteResearchReport: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/research/reports/${id}`, { method: 'DELETE' }),

  runResearch: (payload: { query: string; projectId?: string | null; urls?: string[]; useWebSearch?: boolean }) =>
    requestJson<{ report: ResearchReport }>('/api/v1/research/run', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Phase 2B: Creative Studio & Video Timeline MP4 Engine
  getCreativeCapabilities: () =>
    requestJson<{
      ffmpegAvailable: boolean;
      videoRenderingReady: boolean;
      imageGenerationPaidApiConfigured: boolean;
      imageGenerationStatus: string;
    }>('/api/v1/creative/capabilities'),

  getCreativeAssets: () => requestJson<{ assets: CreativeAssetRecord[] }>('/api/v1/creative/assets'),

  uploadCreativeAsset: (payload: {
    kind: 'image' | 'audio' | 'music' | 'sfx';
    name: string;
    mimeType: string;
    dataBase64: string;
  }) =>
    requestJson<{ asset: CreativeAssetRecord }>('/api/v1/creative/assets', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteCreativeAsset: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/creative/assets/${id}`, { method: 'DELETE' }),

  getCreativeProjects: () => requestJson<{ projects: CreativeProjectRecord[] }>('/api/v1/creative/projects'),

  autoBuildVideoTimeline: (payload: { voiceoverAssetId?: string | null; imageAssetIds: string[] }) =>
    requestJson<{ durationSec: number; clips: VideoTimelineClip[] }>('/api/v1/creative/video/auto-timeline', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  renderCreativeVideo: (payload: {
    title: string;
    aspectRatio: '16:9' | '9:16' | '1:1';
    fps: 24 | 30;
    voiceoverAssetId: string;
    musicAssetId?: string | null;
    musicVolume?: number;
    sfxAssetId?: string | null;
    sfxStartSec?: number;
    sfxVolume?: number;
    clips: VideoTimelineClip[];
  }) =>
    requestJson<{ project: CreativeProjectRecord }>('/api/v1/creative/video/render', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  generateCreativeBrief: (payload: {
    mode: 'storyboard' | 'image_prompt' | 'voice_script' | 'svg_design';
    brief: string;
  }) =>
    requestJson<{ output: string }>('/api/v1/creative/generate-brief', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getIntegrations: () => requestJson<{ connectors: IntegrationConnector[] }>('/api/v1/integrations'),

  connectIntegration: (id: string) =>
    requestJson<{ ok: boolean; redirectUrl?: string }>(`/api/v1/integrations/${id}/connect`, { method: 'POST' }),

  disconnectIntegration: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/integrations/${id}/disconnect`, { method: 'POST' }),

  getBillingSummary: () =>
    requestJson<{
      plan: string;
      role: string;
      subscriptionStatus: string;
      renewalStatus: string;
      paymentProviderConfigured: boolean;
      paymentProviderLabel: string;
      commercialCatalog?: Array<{
        id: string;
        name: string;
        priceUsdMonthly?: number;
        priceDisplay?: string;
        audience?: string;
        dailyTokens: number;
        monthlyTokens: number;
        highlights?: string[];
        checkoutEnabled?: boolean;
      }>;
      plans: Array<{
        id: string;
        name: string;
        audience: string;
        priceDisplay: string;
        dailyLimit: number;
        monthlyLimit: number;
        models: string[];
      }>;
      billingHistory: Array<{ id: string; date: string; amount: string; status: string }>;
      usage: TokenUsageSummary;
    }>('/api/v1/billing/summary'),

  attemptUpgrade: () => requestJson<{ error?: string }>('/api/v1/billing/upgrade', { method: 'POST' }),

  cancelSubscription: () => requestJson<{ ok: boolean; plan: string }>('/api/v1/billing/cancel', { method: 'POST' }),

  updatePreferences: (
    payload: Partial<{
      displayName: string;
      language: AppLanguage;
      theme: AppTheme;
      accentColor: AccentColor;
      fontSize: FontSizePref;
      density: DensityPref;
      soundEnabled: boolean;
      reducedMotion: boolean;
      splashCompleted: boolean;
      defaultModelId: string;
      allowFallback: boolean;
      memoryEnabled: boolean;
      emailNotifications: boolean;
      usageAlerts: boolean;
      chatStreaming: boolean;
    }>
  ) =>
    requestJson<{ user: PublicUser }>('/api/v1/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  exportAllUserData: () => requestJson<Record<string, unknown>>('/api/v1/settings/export'),

  restoreUserData: (archive: Record<string, unknown>) =>
    requestJson<{ ok: boolean; restored: Record<string, number> }>('/api/v1/settings/restore', {
      method: 'POST',
      body: JSON.stringify(archive),
    }),

  getFeatureFlags: () => requestJson<{ flags: FeatureFlag[] }>('/api/v1/settings/flags'),

  getAdminOverview: () =>
    requestJson<{
      users: Array<{
        id: string;
        email: string;
        display_name: string;
        role: string;
        plan: string;
        daily_token_limit: number;
        monthly_token_limit: number;
        created_at: string;
      }>;
      usageStats: { requests: number; totalTokens: number; totalCostUsd: number };
      flags: FeatureFlag[];
      auditLogs: AuditLogEntry[];
    }>('/api/v1/settings/admin/overview'),

  updateAdminFlag: (key: string, enabled: boolean) =>
    requestJson<{ flags: FeatureFlag[] }>(`/api/v1/settings/admin/flags/${key}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  updateAdminUserQuota: (userId: string, dailyTokenLimit: number) =>
    requestJson<{ ok: boolean; dailyTokenLimit: number; monthlyTokenLimit: number }>(
      `/api/v1/settings/admin/users/${userId}/quota`,
      {
        method: 'PATCH',
        body: JSON.stringify({ dailyTokenLimit }),
      }
    ),
};

export async function streamChat(params: {
  conversationId?: string;
  projectId?: string | null;
  modelId: string;
  prompt: string;
  mode?: 'send' | 'regenerate' | 'edit_resend' | 'continue';
  orchestrationMode?: OrchestratorMode;
  targetMessageId?: string;
  allowFallback?: boolean;
  enabledToolIds?: string[];
  documentAttachments?: DocumentAttachment[];
  attachments?: ChatAttachment[];
  signal: AbortSignal;
  onMeta: (meta: ChatStreamMetaEvent) => void;
  onStatus?: (status: ChatStreamStatusEvent) => void;
  onChunk: (text: string) => void;
  onDone: (done: ChatStreamDoneEvent) => void;
  onError: (err: string, meta?: ChatStreamErrorEventMeta) => void;
}) {
  const tRequestStart = performance.now();
  const clientTimings: Record<string, unknown> = {
    modelId: params.modelId,
  };

  const headers = await buildAuthHeaders();
  const resp = await fetch('/api/v1/chat/stream', {
    method: 'POST',
    credentials: 'include',
    headers,
    signal: params.signal,
    body: JSON.stringify({
      conversationId: params.conversationId,
      projectId: params.projectId,
      modelId: params.modelId,
      prompt: params.prompt,
      mode: params.mode ?? 'send',
      orchestrationMode: params.orchestrationMode ?? 'auto',
      targetMessageId: params.targetMessageId,
      allowFallback: params.allowFallback,
      enabledToolIds: params.enabledToolIds,
      documentAttachments: params.documentAttachments,
      attachments: params.attachments,
    }),
  });
  clientTimings.headersMs = Math.round(performance.now() - tRequestStart);

  if (!resp.ok || !resp.body) {
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(typeof data.error === 'string' ? data.error : `Request failed (${resp.status})`, {
      status: resp.status,
      code: typeof data.code === 'string' ? data.code : undefined,
      details: data,
    });
  }

  let firstEventRecorded = false;
  let firstChunkRecorded = false;
  const recordClientTimings = () => {
    if (typeof window !== 'undefined') {
      (window as unknown as { __LOODY_LAST_STREAM_TIMINGS__?: Record<string, unknown> }).__LOODY_LAST_STREAM_TIMINGS__ = {
        ...clientTimings,
      };
    }
  };

  await consumeSseReadableStream(
    resp.body,
    {
      onMeta: (meta) => {
        if (!firstEventRecorded) {
          firstEventRecorded = true;
          clientTimings.firstEventMs = Math.round(performance.now() - tRequestStart);
        }
        params.onMeta(meta);
      },
      onStatus: (status) => {
        if (!firstEventRecorded) {
          firstEventRecorded = true;
          clientTimings.firstEventMs = Math.round(performance.now() - tRequestStart);
        }
        params.onStatus?.(status);
      },
      onChunk: (text) => {
        if (!firstChunkRecorded) {
          firstChunkRecorded = true;
          clientTimings.firstChunkMs = Math.round(performance.now() - tRequestStart);
        }
        params.onChunk(text);
      },
      onDone: (done) => {
        clientTimings.doneMs = Math.round(performance.now() - tRequestStart);
        if (done.timingsMs) {
          clientTimings.serverTimings = done.timingsMs;
        }
        recordClientTimings();
        params.onDone(done);
      },
      onError: (errMsg, errMeta) => {
        clientTimings.errorMs = Math.round(performance.now() - tRequestStart);
        recordClientTimings();
        params.onError(errMsg, errMeta);
      },
    },
    params.signal
  );
}
