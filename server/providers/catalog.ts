import type { ProviderCredentialStatus, ProviderId, ProviderProtocol } from '../../src/shared/types';

export interface ProviderCatalogEntry {
  id: ProviderId;
  displayName: string;
  protocol: ProviderProtocol;
  defaultBaseUrl: string;
  envVars: string[];
  baseUrlEnvVar?: string;
  retired: boolean;
  retiredNotice?: string;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsPromptCaching: boolean;
  supportsStreamOptionsUsage: boolean;
  isGateway?: boolean;
  dailyBudgetUsd: number;
  dailyRequestCap: number;
  extraHeaders?: () => Record<string, string>;
}

const VALID_CF_ACCOUNT_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export function isValidHttpUrlString(raw: string | undefined | null): boolean {
  if (!raw || !raw.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderCatalogEntry> = {
  gemini: {
    id: 'gemini',
    displayName: 'Google AI Studio / Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    envVars: ['GEMINI_API_KEY'],
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 25,
    dailyRequestCap: 5000,
  },
  mistral: {
    id: 'mistral',
    displayName: 'Mistral AI',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    envVars: ['MISTRAL_API_KEY'],
    baseUrlEnvVar: 'MISTRAL_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 15,
    dailyRequestCap: 2500,
  },
  cohere: {
    id: 'cohere',
    displayName: 'Cohere',
    protocol: 'cohere-v2',
    defaultBaseUrl: 'https://api.cohere.com',
    envVars: ['COHERE_API_KEY'],
    baseUrlEnvVar: 'COHERE_BASE_URL',
    retired: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 15,
    dailyRequestCap: 2500,
  },
  xai: {
    id: 'xai',
    displayName: 'xAI (Grok)',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.x.ai/v1',
    envVars: ['XAI_API_KEY'],
    baseUrlEnvVar: 'XAI_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 20,
    dailyRequestCap: 2500,
  },
  ai21: {
    id: 'ai21',
    displayName: 'AI21 Labs',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.ai21.com/studio/v1',
    envVars: ['AI21_API_KEY'],
    baseUrlEnvVar: 'AI21_BASE_URL',
    retired: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 15,
    dailyRequestCap: 2000,
  },
  groq: {
    id: 'groq',
    displayName: 'Groq',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    envVars: ['GROQ_API_KEY'],
    baseUrlEnvVar: 'GROQ_BASE_URL',
    retired: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 15,
    dailyRequestCap: 4000,
  },
  cerebras: {
    id: 'cerebras',
    displayName: 'Cerebras',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    envVars: ['CEREBRAS_API_KEY'],
    baseUrlEnvVar: 'CEREBRAS_BASE_URL',
    retired: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 15,
    dailyRequestCap: 4000,
  },
  sambanova: {
    id: 'sambanova',
    displayName: 'SambaNova Cloud',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.sambanova.ai/v1',
    envVars: ['SAMBANOVA_API_KEY'],
    baseUrlEnvVar: 'SAMBANOVA_BASE_URL',
    retired: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 15,
    dailyRequestCap: 3000,
  },
  together: {
    id: 'together',
    displayName: 'Together AI',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.together.ai/v1',
    envVars: ['TOGETHER_API_KEY'],
    baseUrlEnvVar: 'TOGETHER_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 15,
    dailyRequestCap: 3000,
  },
  fireworks: {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    envVars: ['FIREWORKS_API_KEY'],
    baseUrlEnvVar: 'FIREWORKS_BASE_URL',
    retired: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 15,
    dailyRequestCap: 3000,
  },
  'github-models': {
    id: 'github-models',
    displayName: 'GitHub Models',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://models.github.ai/inference',
    envVars: ['GITHUB_TOKEN'],
    baseUrlEnvVar: 'GITHUB_MODELS_BASE_URL',
    retired: true,
    retiredNotice:
      'GitHub Models inference service was retired on July 30, 2026 and is flagged Unsupported for active chat routing.',
    supportsVision: false,
    supportsStreaming: false,
    supportsTools: false,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 0,
    dailyRequestCap: 0,
  },
  huggingface: {
    id: 'huggingface',
    displayName: 'Hugging Face Inference Providers',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://router.huggingface.co/v1',
    envVars: ['HUGGINGFACE_API_KEY'],
    baseUrlEnvVar: 'HUGGINGFACE_BASE_URL',
    retired: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 10,
    dailyRequestCap: 2500,
  },
  cloudflare: {
    id: 'cloudflare',
    displayName: 'Cloudflare Workers AI',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1',
    envVars: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
    baseUrlEnvVar: 'CLOUDFLARE_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: false,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 10,
    dailyRequestCap: 3000,
  },
  nvidia: {
    id: 'nvidia',
    displayName: 'NVIDIA NIM',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    envVars: ['NVIDIA_API_KEY'],
    baseUrlEnvVar: 'NVIDIA_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 15,
    dailyRequestCap: 2500,
  },
  deepinfra: {
    id: 'deepinfra',
    displayName: 'DeepInfra',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
    envVars: ['DEEPINFRA_API_KEY'],
    baseUrlEnvVar: 'DEEPINFRA_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 15,
    dailyRequestCap: 3000,
  },
  'openai-compatible': {
    id: 'openai-compatible',
    displayName: 'OpenAI / Direct Compatible',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    envVars: ['OPENAI_API_KEY'],
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    dailyBudgetUsd: 25,
    dailyRequestCap: 3000,
  },
  'anthropic-compatible': {
    id: 'anthropic-compatible',
    displayName: 'Anthropic (Claude)',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    envVars: ['ANTHROPIC_API_KEY'],
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: true,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 25,
    dailyRequestCap: 2500,
  },
  'hosted-oss': {
    id: 'hosted-oss',
    displayName: 'Hosted Open-Weight Endpoint',
    protocol: 'openai-compatible',
    defaultBaseUrl: '',
    envVars: ['HOSTED_OSS_BASE_URL'],
    baseUrlEnvVar: 'HOSTED_OSS_BASE_URL',
    retired: false,
    supportsVision: false,
    supportsStreaming: true,
    supportsTools: false,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: false,
    dailyBudgetUsd: 20,
    dailyRequestCap: 5000,
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    envVars: ['OPENROUTER_API_KEY'],
    baseUrlEnvVar: 'OPENROUTER_BASE_URL',
    retired: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsTools: true,
    supportsPromptCaching: false,
    supportsStreamOptionsUsage: true,
    isGateway: true,
    dailyBudgetUsd: 20,
    dailyRequestCap: 3000,
    extraHeaders: () => {
      const appUrl = process.env.APP_URL?.trim();
      return {
        ...(isValidHttpUrlString(appUrl) ? { 'HTTP-Referer': appUrl! } : {}),
        'X-OpenRouter-Title': 'LOODY AI Workspace',
      };
    },
  },
};

export const ALL_PROVIDER_IDS = Object.keys(PROVIDER_CATALOG) as ProviderId[];

export function getProviderCatalogEntry(provider: string): ProviderCatalogEntry | null {
  return (PROVIDER_CATALOG as Record<string, ProviderCatalogEntry | undefined>)[provider] ?? null;
}

export interface ResolvedProviderCredentials {
  configured: boolean;
  credentialStatus: ProviderCredentialStatus;
  retired: boolean;
  apiKey?: string;
  baseUrl?: string;
  configuredReason: string;
  missingReason: string;
}

export function resolveProviderCredentials(params: {
  provider: string;
  overrideApiKey?: string;
  hasEncryptedKey?: boolean;
  customBaseUrl?: string | null;
}): ResolvedProviderCredentials {
  const entry = getProviderCatalogEntry(params.provider);
  if (!entry) {
    return {
      configured: false,
      credentialStatus: 'awaiting_credentials',
      retired: false,
      configuredReason: '',
      missingReason: `Unsupported provider adapter: ${params.provider}`,
    };
  }

  if (entry.retired) {
    return {
      configured: false,
      credentialStatus: 'retired_unsupported',
      retired: true,
      configuredReason: '',
      missingReason: entry.retiredNotice ?? `${entry.displayName} is retired and unsupported.`,
    };
  }

  const envBaseOverride = entry.baseUrlEnvVar ? process.env[entry.baseUrlEnvVar]?.trim() : undefined;
  const candidateCustomBase = params.customBaseUrl?.trim() || envBaseOverride || '';

  if (entry.id === 'gemini') {
    const rawKey = params.overrideApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
    const validKey = Boolean(rawKey && rawKey !== 'MY_GEMINI_API_KEY');
    const configured = Boolean(params.hasEncryptedKey) || validKey;
    return {
      configured,
      credentialStatus: configured ? 'configured' : 'awaiting_credentials',
      retired: false,
      apiKey: validKey ? rawKey : undefined,
      baseUrl: entry.defaultBaseUrl,
      configuredReason: params.hasEncryptedKey
        ? 'Configured via Developer Gemini API key (connectivity test pending)'
        : 'Configured via server-side GEMINI_API_KEY adapter (connectivity test pending)',
      missingReason: 'GEMINI_API_KEY not configured on server',
    };
  }

  if (entry.id === 'hosted-oss') {
    const baseOk = isValidHttpUrlString(candidateCustomBase);
    const rawKey = params.overrideApiKey?.trim() || process.env.HOSTED_OSS_API_KEY?.trim();
    return {
      configured: baseOk,
      credentialStatus: baseOk ? 'configured' : 'awaiting_credentials',
      retired: false,
      apiKey: rawKey || undefined,
      baseUrl: baseOk ? candidateCustomBase.replace(/\/$/, '') : undefined,
      configuredReason: 'Configured via Hosted OSS base URL (connectivity test pending)',
      missingReason: 'Awaiting valid http(s) HOSTED_OSS_BASE_URL or custom base URL configuration',
    };
  }

  if (entry.id === 'cloudflare') {
    const token = params.overrideApiKey?.trim() || process.env.CLOUDFLARE_API_TOKEN?.trim();
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || '';
    const hasCustomBase = isValidHttpUrlString(candidateCustomBase);
    const validAccountId = VALID_CF_ACCOUNT_RE.test(accountId);
    const resolvedBase = hasCustomBase
      ? candidateCustomBase.replace(/\/$/, '')
      : validAccountId
        ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
        : undefined;
    const hasKey = Boolean(params.hasEncryptedKey) || Boolean(token);
    const configured = hasKey && Boolean(resolvedBase);

    let missingReason = 'Awaiting CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN';
    if (hasKey && !validAccountId && !hasCustomBase) {
      missingReason = 'Awaiting valid CLOUDFLARE_ACCOUNT_ID for Workers AI endpoint';
    } else if (!hasKey && (validAccountId || hasCustomBase)) {
      missingReason = 'Awaiting CLOUDFLARE_API_TOKEN';
    }

    return {
      configured,
      credentialStatus: configured ? 'configured' : 'awaiting_credentials',
      retired: false,
      apiKey: token || undefined,
      baseUrl: resolvedBase,
      configuredReason: 'Configured via Cloudflare Workers AI credentials (connectivity test pending)',
      missingReason,
    };
  }

  // Standard key + base URL resolution (including HUGGINGFACE_API_KEY / HF_TOKEN alias)
  let rawKey = params.overrideApiKey?.trim();
  if (!rawKey) {
    for (const envName of entry.envVars) {
      const v = process.env[envName]?.trim();
      if (v) {
        rawKey = v;
        break;
      }
    }
    if (!rawKey && entry.id === 'huggingface' && process.env.HF_TOKEN?.trim()) {
      rawKey = process.env.HF_TOKEN.trim();
    }
  }

  const resolvedBase = isValidHttpUrlString(candidateCustomBase)
    ? candidateCustomBase.replace(/\/$/, '')
    : entry.defaultBaseUrl;
  const configured = (Boolean(params.hasEncryptedKey) || Boolean(rawKey)) && isValidHttpUrlString(resolvedBase);

  return {
    configured,
    credentialStatus: configured ? 'configured' : 'awaiting_credentials',
    retired: false,
    apiKey: rawKey || undefined,
    baseUrl: resolvedBase,
    configuredReason: params.hasEncryptedKey
      ? `Configured via Developer ${entry.displayName} credentials (connectivity test pending)`
      : `Configured via ${entry.envVars.join(' / ')} adapter (connectivity test pending)`,
    missingReason: `Awaiting ${entry.envVars.join(' + ')} configuration`,
  };
}

export interface EnvVarPresenceReport {
  name: string;
  configured: boolean;
  providerGroup: 'gemini' | 'groq' | 'nvidia' | 'other';
}

/**
 * Inspects server-side environment variable NAMES and boolean configured status ONLY.
 * Never reads, hashes, slices, or returns secret values.
 */
export function inspectProviderEnvVarNames(): EnvVarPresenceReport[] {
  const canonicalNames = [
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'NVIDIA_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'MISTRAL_API_KEY',
    'COHERE_API_KEY',
    'XAI_API_KEY',
    'AI21_API_KEY',
    'CEREBRAS_API_KEY',
    'SAMBANOVA_API_KEY',
    'TOGETHER_API_KEY',
    'FIREWORKS_API_KEY',
    'HUGGINGFACE_API_KEY',
    'HF_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'DEEPINFRA_API_KEY',
    'OPENROUTER_API_KEY',
    'HOSTED_OSS_BASE_URL',
  ];

  const seen = new Set<string>();
  const results: EnvVarPresenceReport[] = [];

  const classifyGroup = (name: string): EnvVarPresenceReport['providerGroup'] => {
    if (/gemini/i.test(name)) return 'gemini';
    if (/groq/i.test(name)) return 'groq';
    if (/nvidia|nim|ngc/i.test(name)) return 'nvidia';
    return 'other';
  };

  for (const name of canonicalNames) {
    seen.add(name);
    const val = process.env[name];
    const configured = Boolean(val && val.trim() && val.trim() !== 'MY_GEMINI_API_KEY');
    results.push({ name, configured, providerGroup: classifyGroup(name) });
  }

  // Also detect any additional NVIDIA/NV/NIM/NGC/GROQ/GEMINI environment variables without leaking values
  for (const envName of Object.keys(process.env).sort()) {
    if (seen.has(envName)) continue;
    if (/^(NVIDIA|NV_|NIM_|NGC_|GROQ|GEMINI)[A-Z0-9_]*$/i.test(envName) || /NVIDIA/i.test(envName)) {
      const val = process.env[envName];
      const configured = Boolean(val && val.trim() && val.trim() !== 'MY_GEMINI_API_KEY');
      results.push({
        name: envName,
        configured,
        providerGroup: classifyGroup(envName),
      });
      seen.add(envName);
    }
  }

  return results;
}

