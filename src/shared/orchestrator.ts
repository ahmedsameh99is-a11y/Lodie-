import type {
  AvailabilityStatus,
  ErrorClass,
  OrchestratorMode,
  VideoTimelineClip,
} from './types';

export function classifyIntentMode(
  prompt: string,
  explicitMode?: OrchestratorMode
): Exclude<OrchestratorMode, 'auto'> {
  if (explicitMode && explicitMode !== 'auto') {
    return explicitMode;
  }
  const lower = prompt.toLowerCase();
  if (
    /\b(code|typescript|react|function|bug|refactor|sql|api|architecture|security|audit|test|regex|compile|debug)\b/.test(
      lower
    )
  ) {
    return 'coding';
  }
  if (
    /\b(research|sources|citations|latest|compare studies|evidence|web|fact-check|literature|verify)\b/.test(
      lower
    )
  ) {
    return 'research';
  }
  if (/\b(video|story|script|design|svg|animation|creative|brand|music|audio|storyboard)\b/.test(lower)) {
    return 'creative';
  }
  if (/\b(csv|dataset|analyze|statistics|regression|metrics|kpi|table|spreadsheet)\b/.test(lower)) {
    return 'analysis';
  }
  if (/\b(plan|milestone|task|roadmap|workflow|project schedule|deliverable)\b/.test(lower)) {
    return 'work';
  }
  if (prompt.length > 260 || /\b(why|explain in depth|tradeoff|step by step|proof)\b/.test(lower)) {
    return 'deep_thinking';
  }
  return 'fast';
}

export function classifyProviderError(
  rawMessage: string,
  httpStatus?: number
): {
  errorClass: ErrorClass;
  healthStatus: AvailabilityStatus;
  retryable: boolean;
  userMessage: string;
} {
  const lower = rawMessage.toLowerCase();

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    lower.includes('api key') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid key') ||
    lower.includes('permission denied')
  ) {
    return {
      errorClass: lower.includes('not configured') ? 'configuration_error' : 'auth_error',
      healthStatus: lower.includes('not configured') ? 'configuration_error' : 'authentication_error',
      retryable: false,
      userMessage: 'Authentication or API key configuration error on upstream model provider.',
    };
  }

  if (
    httpStatus === 404 ||
    lower.includes('model not found') ||
    lower.includes('not found for api version') ||
    lower.includes('is not supported for') ||
    lower.includes('does not exist') ||
    lower.includes('unknown model')
  ) {
    return {
      errorClass: 'configuration_error',
      healthStatus: 'configuration_error',
      retryable: false,
      userMessage: 'Configured upstream model ID or provider endpoint is invalid or unsupported.',
    };
  }

  if (
    httpStatus === 429 ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('resource_exhausted')
  ) {
    return {
      errorClass: 'rate_limit',
      healthStatus: 'temporarily_unavailable',
      retryable: true,
      userMessage: 'Provider rate limit reached temporarily.',
    };
  }

  if (lower.includes('quota') || lower.includes('billing') || lower.includes('insufficient_quota')) {
    return {
      errorClass: 'quota_exceeded',
      healthStatus: 'temporarily_unavailable',
      retryable: false,
      userMessage: 'Upstream provider quota or billing allowance exhausted.',
    };
  }

  if (
    httpStatus === 504 ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted')
  ) {
    return {
      errorClass: 'latency',
      healthStatus: 'temporarily_unavailable',
      retryable: true,
      userMessage: 'Upstream model timed out under load.',
    };
  }

  if (
    httpStatus === 503 ||
    httpStatus === 502 ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('fetch failed')
  ) {
    return {
      errorClass: 'provider_unavailable',
      healthStatus: 'temporarily_unavailable',
      retryable: true,
      userMessage: 'Upstream model service is temporarily unavailable.',
    };
  }

  return {
    errorClass: 'provider_unavailable',
    healthStatus: 'error',
    retryable: false,
    userMessage: rawMessage || 'Unexpected provider error.',
  };
}

export interface DagNode {
  id: string;
  dependsOn: string[];
}

/**
 * Topologically groups multi-agent execution steps into parallelizable execution waves.
 * Throws if an unknown dependency or dependency cycle exists.
 */
export function buildDagExecutionBatches<T extends DagNode>(nodes: T[]): T[][] {
  const byId = new Map<string, T>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        throw new Error(`Step "${node.id}" depends on unknown step "${dep}".`);
      }
      if (dep === node.id) {
        throw new Error(`Step "${node.id}" cannot depend on itself.`);
      }
    }
  }

  const remaining = new Set(nodes.map((n) => n.id));
  const completed = new Set<string>();
  const batches: T[][] = [];

  while (remaining.size > 0) {
    const ready: T[] = [];
    for (const id of remaining) {
      const node = byId.get(id)!;
      if (node.dependsOn.every((d) => completed.has(d))) {
        ready.push(node);
      }
    }
    if (ready.length === 0) {
      throw new Error('Cycle detected in agent task dependency graph.');
    }
    for (const r of ready) {
      remaining.delete(r.id);
      completed.add(r.id);
    }
    batches.push(ready);
  }

  return batches;
}

export function evaluateToolPermission(params: {
  permissionLevel: 'read_only' | 'compute' | 'restricted';
  requiresApproval?: boolean;
  approvedByUser?: boolean;
  enabled: boolean;
}): { allowed: boolean; requiresApproval?: boolean; reason?: string } {
  if (!params.enabled) {
    return { allowed: false, reason: 'Tool is disabled in the Tool Directory.' };
  }
  if ((params.permissionLevel === 'restricted' || params.requiresApproval) && !params.approvedByUser) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: 'Restricted or state-mutating tool requires explicit user approval.',
    };
  }
  return { allowed: true };
}

export function validateSkillDefinition(skill: {
  name: string;
  version: string;
  description: string;
  promptTemplate: string;
  allowedTools: string[];
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (skill.name.trim().length < 2 || skill.name.trim().length > 80) {
    errors.push('Skill name must be 2-80 characters.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(skill.version.trim())) {
    errors.push('Skill version must use semver format (e.g., 1.0.0).');
  }
  if (skill.description.trim().length < 8) {
    errors.push('Description must be at least 8 characters.');
  }
  if (skill.promptTemplate.trim().length < 10) {
    errors.push('Prompt template must be at least 10 characters.');
  }
  if (!Array.isArray(skill.allowedTools) || skill.allowedTools.length > 16) {
    errors.push('Allowed tools must be an array of up to 16 tool IDs.');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Automatically arranges uploaded images evenly across the measured voiceover audio duration,
 * alternating subtle motion presets and smooth transitions when not explicitly specified.
 */
export function arrangeImagesOnVoiceoverTimeline(
  images: Array<{ assetId: string; name: string }>,
  audioDurationSec: number
): VideoTimelineClip[] {
  if (images.length === 0) return [];
  const totalSec = Math.max(images.length * 1.5, Math.min(600, audioDurationSec || images.length * 3));
  const sliceSec = Number((totalSec / images.length).toFixed(2));
  const motions: VideoTimelineClip['motion'][] = ['zoom_in', 'pan_left', 'zoom_out', 'pan_right'];

  let cursor = 0;
  return images.map((img, idx) => {
    const isLast = idx === images.length - 1;
    const duration = isLast ? Number(Math.max(1.0, totalSec - cursor).toFixed(2)) : sliceSec;
    const clip: VideoTimelineClip = {
      id: `clip-${idx + 1}-${img.assetId.slice(0, 6)}`,
      assetId: img.assetId,
      name: img.name,
      startSec: Number(cursor.toFixed(2)),
      durationSec: duration,
      motion: motions[idx % motions.length],
      transition: idx === 0 ? 'none' : 'fade',
    };
    cursor += duration;
    return clip;
  });
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  oldLine?: number;
  newLine?: number;
  text: string;
}

/**
 * Computes a deterministic line-level unified diff between two text snapshots using LCS.
 */
export function computeUnifiedLineDiff(beforeText: string, afterText: string): DiffLine[] {
  const a = beforeText.replace(/\r\n/g, '\n').split('\n');
  const b = afterText.replace(/\r\n/g, '\n').split('\n');
  const m = a.length;
  const n = b.length;

  // Guard against excessively large files in DP memory
  if (m * n > 250_000) {
    return [
      ...a.map((text, idx) => ({ type: 'remove' as const, oldLine: idx + 1, text })),
      ...b.map((text, idx) => ({ type: 'add' as const, newLine: idx + 1, text })),
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ type: 'context', oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', oldLine: i + 1, text: a[i] });
      i++;
    } else {
      result.push({ type: 'add', newLine: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ type: 'remove', oldLine: i + 1, text: a[i] });
    i++;
  }
  while (j < n) {
    result.push({ type: 'add', newLine: j + 1, text: b[j] });
    j++;
  }
  return result;
}

