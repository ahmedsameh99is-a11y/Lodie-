export type UserRole = 'user' | 'developer' | 'admin';
export type PlanTier = 'free' | 'premium' | 'developer';
export type AppLanguage = 'en' | 'ar';
export type AppTheme = 'dark' | 'light' | 'system';
export type AccentColor = 'emerald' | 'teal' | 'mint' | 'slate';
export type FontSizePref = 'sm' | 'md' | 'lg';
export type DensityPref = 'comfortable' | 'compact';
export type ProviderId = 'gemini' | 'openai-compatible' | 'anthropic-compatible' | 'hosted-oss';
export type ModelTier = 'free' | 'premium' | 'multimodal';
export type AvailabilityStatus =
  | 'operational'
  | 'connected'
  | 'slow'
  | 'temporarily_unavailable'
  | 'configuration_error'
  | 'authentication_error'
  | 'awaiting_config'
  | 'disabled'
  | 'error';

export type ErrorClass =
  | 'rate_limit'
  | 'auth_error'
  | 'latency'
  | 'quota_exceeded'
  | 'provider_unavailable'
  | 'configuration_error'
  | 'validation_error';

export type OrchestratorMode =
  | 'auto'
  | 'fast'
  | 'deep_thinking'
  | 'research'
  | 'coding'
  | 'creative'
  | 'analysis'
  | 'work';

export type MemoryScope =
  | 'user'
  | 'conversation'
  | 'project'
  | 'knowledge'
  | 'task'
  | 'operational';

export type FileCategory = 'document' | 'spreadsheet' | 'image' | 'audio' | 'video' | 'code' | 'text';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  plan: PlanTier;
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
  authProvider: string;
  emailVerified: boolean;
  dailyTokenLimit: number;
  monthlyTokenLimit: number;
  createdAt: string;
}

export interface BrandedModel {
  id: string;
  displayName: string;
  tier: ModelTier;
  requiredPlan: 'free' | 'premium';
  provider: ProviderId;
  upstreamModelId: string;
  description: string;
  speedClass: 'Ultra-Fast' | 'Fast' | 'Balanced' | 'Deep Reasoning';
  reasoningLevel: 'Standard' | 'High' | 'Deep';
  contextLimit: number | null;
  inputModalities: Array<'text' | 'image'>;
  outputModalities: Array<'text'>;
  supportsTools: boolean;
  supportsStreaming: boolean;
  pricingSummary: string;
  availability: AvailabilityStatus;
  availabilityReason: string;
  lastTestedAt: string | null;
  thinkingPreset?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';
  errorClass?: ErrorClass | null;
  avgLatencyMs?: number | null;
}

export interface ProjectFileRecord {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
  summary?: string;
  fileCategory?: FileCategory;
  hasBinary?: boolean;
  createdAt: string;
}

export interface WorkspaceFileRecord {
  id: string;
  userId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
  folder: string;
  tags: string[];
  summary: string;
  fileCategory: FileCategory;
  hasBinary: boolean;
  createdAt: string;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string;
  instructions: string;
  preferredModelId: string;
  enabledTools: string[];
  createdAt: string;
  updatedAt: string;
  conversationCount?: number;
  fileCount?: number;
  memoryCount?: number;
  lastActiveAt?: string | null;
}

export interface UserMemory {
  id: string;
  userId: string;
  projectId: string | null;
  scope: MemoryScope;
  category: 'preference' | 'fact' | 'instruction';
  content: string;
  sourceType: 'user_approved' | 'extracted';
  approved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeCitation {
  chunkId: string;
  sourceType: 'workspace_file' | 'project_file' | 'memory';
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
  retrievalMethod: 'embedding' | 'lexical';
}

export interface Conversation {
  id: string;
  userId: string;
  projectId: string | null;
  folder: string;
  pinned: boolean;
  archived: boolean;
  shareId: string | null;
  title: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAttachment {
  mimeType: string;
  dataBase64: string;
  name: string;
  sizeBytes: number;
}

export interface DocumentAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: Array<{ mimeType: string; name: string; previewUrl?: string; kind?: 'image' | 'document' }>;
  citations?: KnowledgeCitation[];
  modelId?: string;
  provider?: ProviderId;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  tokenAccountingType?: 'provider_reported' | 'estimated';
  createdAt: string;
}

export interface ConversationShare {
  id: string;
  conversationId: string;
  title: string;
  modelId: string;
  active: boolean;
  transcript: string;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsageSummary {
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  providerReportedTotal: number;
  estimatedTotal: number;
  estimatedCostUsd: number;
  byTaskType?: Record<string, { tokens: number; costUsd: number; count: number }>;
  recentEntries: Array<{
    id: string;
    modelId: string;
    provider: ProviderId;
    taskType?: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    accountingType: 'provider_reported' | 'estimated';
    estimatedCostUsd: number;
    createdAt: string;
  }>;
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sensitive: boolean;
  sensitivityReason?: string;
}

export interface McpServerRecord {
  id: string;
  userId: string;
  name: string;
  endpointUrl: string;
  authType: 'none' | 'bearer' | 'header';
  status: 'connected' | 'awaiting_test' | 'disconnected' | 'error';
  lastError: string | null;
  tools: McpToolSchema[];
  createdAt: string;
}

export interface McpApprovalRequest {
  id: string;
  userId: string;
  serverId: string;
  toolName: string;
  argumentsJson: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
  createdAt: string;
}

export interface McpServerTokenRecord {
  id: string;
  userId: string;
  label: string;
  tokenPrefix: string;
  allowedTools: string[];
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface BuiltinTool {
  id: string;
  name: string;
  description: string;
  category?: string;
  permissionLevel: 'read_only' | 'compute' | 'restricted';
  requiresApproval?: boolean;
  available?: boolean;
  availabilityDetail?: string;
  enabled: boolean;
  inputExample: Record<string, unknown>;
}

export interface ToolExecutionLogEntry {
  id: string;
  userId: string;
  toolId: string;
  category: string;
  status: 'success' | 'error' | 'denied';
  durationMs: number;
  inputJson: string;
  outputJson: string;
  createdAt: string;
}

export interface IntegrationConnector {
  id: string;
  name: string;
  category: string;
  description: string;
  permissions: string[];
  status: 'connected' | 'awaiting_config' | 'error';
  statusDetail: string;
  connectedAccountLabel: string | null;
}

export interface FeatureFlag {
  key: string;
  label: string;
  stage: 'stage_1' | 'stage_2';
  enabled: boolean;
  description: string;
}

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: 'success' | 'denied' | 'error';
  detail: string;
  createdAt: string;
}

export type SpecialistAgentId =
  | 'kore'
  | 'research'
  | 'work'
  | 'creative'
  | 'data'
  | 'education'
  | 'business';

export interface AgentProfile {
  id: SpecialistAgentId;
  name: string;
  roleTitle: string;
  description: string;
  allowedTools: string[];
  defaultMode: OrchestratorMode;
}

export interface AgentStepRecord {
  id: string;
  runId: string;
  agentId: SpecialistAgentId;
  title: string;
  dependsOn: string[];
  toolIds: string[];
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  inputSummary: string;
  outputText: string;
  approvalRequired: boolean;
  approvalStatus: 'none' | 'pending' | 'approved' | 'rejected';
  durationMs: number;
  errorMessage: string | null;
  stepOrder: number;
}

export interface AgentRunRecord {
  id: string;
  userId: string;
  projectId: string | null;
  goal: string;
  mode: OrchestratorMode;
  status: 'queued' | 'running' | 'paused' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  finalOutput: string;
  totalTokens: number;
  idempotencyKey?: string | null;
  steps: AgentStepRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackage {
  id: string;
  ownerUserId: string | null;
  projectId: string | null;
  name: string;
  version: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  allowedTools: string[];
  promptTemplate: string;
  isBuiltin: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTask {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  description: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  priority: 'low' | 'medium' | 'high';
  templateName: string | null;
  recurringCron: string | null;
  dueAt: string | null;
  subtasks: Array<{ id: string; title: string; completed: boolean; sortOrder: number }>;
  milestones: Array<{ id: string; title: string; status: 'pending' | 'reached'; targetDate: string | null }>;
  createdAt: string;
  updatedAt: string;
}

export interface KoreWorkspaceRecord {
  id: string;
  userId: string;
  projectId: string | null;
  name: string;
  description: string;
  language: string;
  fileCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface KoreFileRecord {
  id: string;
  workspaceId: string;
  path: string;
  language: string;
  content: string;
  updatedAt: string;
}

export interface KoreReviewRecord {
  id: string;
  workspaceId: string;
  instruction: string;
  targetPath: string | null;
  summary: string;
  findings: Array<{ severity: string; filePath: string; issue: string; fix: string }>;
  proposedPatch: { filePath: string; diffSummary: string; updatedContent: string } | null;
  applied: boolean;
  createdAt: string;
}

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
  retrievedAt: string;
  verifiedType: 'google_search_grounding' | 'fetched_url';
}

export interface ResearchReport {
  id: string;
  userId: string;
  projectId: string | null;
  query: string;
  summary: string;
  findings: Array<{ claim: string; evidence: string; confidence: 'high' | 'medium' | 'low'; conflictNote?: string }>;
  sources: ResearchSource[];
  groundingsAvailable: boolean;
  createdAt: string;
}

export interface VideoTimelineClip {
  id: string;
  assetId: string;
  name: string;
  startSec: number;
  durationSec: number;
  motion: 'none' | 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right';
  transition: 'none' | 'fade' | 'wipe';
}

export interface VideoProjectConfig {
  aspectRatio: '16:9' | '9:16' | '1:1';
  fps: 24 | 30;
  voiceoverAssetId: string | null;
  voiceoverDurationSec: number;
  musicAssetId: string | null;
  musicVolume: number;
  sfxAssetId: string | null;
  sfxStartSec: number;
  sfxVolume: number;
  clips: VideoTimelineClip[];
}

export interface CreativeAssetRecord {
  id: string;
  userId: string;
  kind: 'image' | 'audio' | 'music' | 'sfx' | 'video';
  name: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  downloadUrl: string;
  createdAt: string;
}

export interface CreativeProjectRecord {
  id: string;
  userId: string;
  projectId: string | null;
  kind: 'video_timeline' | 'image_studio' | 'audio_studio' | 'design_studio' | 'animation_studio';
  title: string;
  config: Record<string, unknown>;
  outputDownloadUrl: string | null;
  mimeType: string | null;
  durationSec: number | null;
  status: 'draft' | 'rendered' | 'failed';
  createdAt: string;
  updatedAt: string;
}
