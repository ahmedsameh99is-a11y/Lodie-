import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { classifyProviderError } from '../../src/shared/orchestrator';
import type { AvailabilityStatus, BrandedModel, ChatAttachment, ErrorClass } from '../../src/shared/types';
import { getModelCredentials } from '../db';
import { getProviderCatalogEntry, resolveProviderCredentials } from './catalog';

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
}

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onFirstToken?: (ttftMs: number) => void;
  onUsage?: (usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  }) => void;
}

export class ProviderExecutionError extends Error {
  errorClass: ErrorClass;
  healthStatus: AvailabilityStatus;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  partialEmitted?: boolean;

  constructor(
    message: string,
    meta: {
      errorClass: ErrorClass;
      healthStatus: AvailabilityStatus;
      retryable: boolean;
      httpStatus?: number;
      retryAfterMs?: number;
      partialEmitted?: boolean;
    }
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
    this.errorClass = meta.errorClass;
    this.healthStatus = meta.healthStatus;
    this.retryable = meta.retryable;
    this.httpStatus = meta.httpStatus;
    this.retryAfterMs = meta.retryAfterMs;
    this.partialEmitted = meta.partialEmitted;
  }
}

export function parseRetryAfterMs(headerVal: string | null | undefined): number | undefined {
  if (!headerVal || !headerVal.trim()) return undefined;
  const trimmed = headerVal.trim();
  const secs = Number(trimmed);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.round(secs * 1000);
  }
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return undefined;
}

export function parseRetryAfterFromErrorMessage(message: string): number | undefined {
  const match = /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
  if (match && (match[1] || match[2] || match[3])) {
    const hours = Number(match[1] ?? 0);
    const mins = Number(match[2] ?? 0);
    const secs = Number(match[3] ?? 0);
    const totalMs = Math.round((hours * 3600 + mins * 60 + secs) * 1000);
    if (totalMs > 0) return totalMs;
  }
  if (/free_tier_requests|limit:\s*20|quota exceeded/i.test(message)) {
    return 600_000;
  }
  return undefined;
}

export function createGeminiClient(overrideKey?: string): GoogleGenAI | null {
  const apiKey = overrideKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function mapThinkingLevel(preset?: BrandedModel['thinkingPreset'], _upstreamModelId?: string): ThinkingLevel | undefined {
  if (!preset) return undefined;
  switch (preset) {
    case 'MINIMAL':
      return ThinkingLevel.MINIMAL;
    case 'LOW':
      return ThinkingLevel.LOW;
    case 'MEDIUM':
      return ThinkingLevel.MEDIUM;
    case 'HIGH':
    case 'XHIGH':
      return ThinkingLevel.HIGH;
    default:
      return undefined;
  }
}

export function extractReadableError(err: unknown): { message: string; retryable: boolean; status?: number } {
  const raw = err instanceof Error ? err.message : String(err);
  let status: number | undefined;
  let parsedMsg = raw;

  try {
    const first = JSON.parse(raw);
    const inner = first?.error ?? first;
    if (typeof inner?.code === 'number') status = inner.code;
    if (typeof inner?.message === 'string') {
      try {
        const second = JSON.parse(inner.message);
        const deep = second?.error ?? second;
        if (typeof deep?.code === 'number') status = deep.code;
        if (typeof deep?.message === 'string') parsedMsg = deep.message;
        else parsedMsg = inner.message;
      } catch {
        parsedMsg = inner.message;
      }
    } else if (typeof first?.message === 'string') {
      parsedMsg = first.message;
    }
  } catch {
    // Keep raw text
  }

  const classified = classifyProviderError(parsedMsg, status);
  return { message: parsedMsg, retryable: classified.retryable, status };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAttemptSignal(
  userSignal?: AbortSignal,
  timeoutMs = 25_000
): { signal: AbortSignal; timeoutSignal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return { signal: timeoutSignal, timeoutSignal };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([userSignal, timeoutSignal]), timeoutSignal };
  }
  return { signal: userSignal, timeoutSignal };
}

function normalizeTimeoutOrAbortError(params: {
  err: unknown;
  model: Pick<BrandedModel, 'displayName' | 'provider' | 'upstreamModelId'>;
  timeoutMs: number;
  userSignal?: AbortSignal;
  timeoutSignal?: AbortSignal;
  partialEmitted?: boolean;
}): ProviderExecutionError | null {
  if (params.userSignal?.aborted) {
    return null; // Caller intentionally aborted
  }
  const errName = (params.err as { name?: string })?.name;
  const timedOut = Boolean(params.timeoutSignal?.aborted) || errName === 'TimeoutError';

  if (timedOut) {
    const secs = Math.max(1, Math.round(params.timeoutMs / 1000));
    return new ProviderExecutionError(
      `${params.model.displayName} timed out after ${secs}s waiting for ${params.model.provider}/${params.model.upstreamModelId}.`,
      {
        errorClass: 'latency',
        healthStatus: 'temporarily_unavailable',
        retryable: true,
        httpStatus: 504,
        partialEmitted: params.partialEmitted,
      }
    );
  }
  return null;
}

export async function generateModelText(params: {
  upstreamModelId?: string;
  systemInstruction: string;
  prompt: string;
  thinkingPreset?: BrandedModel['thinkingPreset'];
  timeoutMs?: number;
  allowFallback?: boolean;
  signal?: AbortSignal;
}): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  modelUsed: string;
  fallbackUsed?: boolean;
}> {
  const ai = createGeminiClient();
  if (!ai) {
    throw new ProviderExecutionError('GEMINI_API_KEY is not configured on the server.', {
      errorClass: 'configuration_error',
      healthStatus: 'awaiting_config',
      retryable: false,
    });
  }
  const timeoutMs = params.timeoutMs ?? 25_000;
  const requestedModel = params.upstreamModelId ?? 'gemini-3.1-flash-lite';
  const candidates =
    params.allowFallback !== false && requestedModel === 'gemini-3.1-flash-lite'
      ? ['gemini-3.1-flash-lite', 'gemini-3.6-flash']
      : [requestedModel];
  const start = Date.now();
  let lastInfo: { message: string; status?: number; cls: ReturnType<typeof classifyProviderError> } | null = null;

  for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
    const modelId = candidates[cIdx];
    const { signal: attemptSignal, timeoutSignal } = createAttemptSignal(params.signal, timeoutMs);
    try {
      const config: Record<string, unknown> = {
        systemInstruction: params.systemInstruction,
        abortSignal: attemptSignal,
      };
      const level = mapThinkingLevel(params.thinkingPreset, modelId);
      if (level) {
        config.thinkingConfig = { thinkingLevel: level };
      }
      const resp = await ai.models.generateContent({
        model: modelId,
        contents: params.prompt,
        config,
      });
      return {
        text: (resp.text ?? '').trim(),
        inputTokens: Number(resp.usageMetadata?.promptTokenCount ?? 0),
        outputTokens: Number(resp.usageMetadata?.candidatesTokenCount ?? 0),
        cachedTokens: Number(resp.usageMetadata?.cachedContentTokenCount ?? 0),
        latencyMs: Date.now() - start,
        modelUsed: modelId,
        fallbackUsed: modelId !== requestedModel,
      };
    } catch (err) {
      if (params.signal?.aborted) {
        throw err;
      }
      const timed = normalizeTimeoutOrAbortError({
        err,
        model: { displayName: modelId, provider: 'gemini', upstreamModelId: modelId },
        timeoutMs,
        userSignal: params.signal,
        timeoutSignal,
      });
      if (timed) {
        lastInfo = {
          message: timed.message,
          status: 504,
          cls: {
            errorClass: timed.errorClass,
            healthStatus: timed.healthStatus,
            retryable: true,
            userMessage: timed.message,
          },
        };
        if (cIdx < candidates.length - 1) continue;
        throw timed;
      }
      const info = extractReadableError(err);
      const cls = classifyProviderError(info.message, info.status);
      lastInfo = { message: info.message, status: info.status, cls };
      if (!cls.retryable && cIdx === candidates.length - 1) {
        throw new ProviderExecutionError(info.message, { ...cls, httpStatus: info.status });
      }
    }
  }

  const finalErr = lastInfo ?? {
    message: 'Upstream model call failed.',
    cls: classifyProviderError('Upstream unavailable', 503),
  };
  throw new ProviderExecutionError(finalErr.message, { ...finalErr.cls, httpStatus: finalErr.status });
}

function formatOpenAiContent(m: ProviderMessage): unknown {
  if (!m.attachments || m.attachments.length === 0) {
    return m.content;
  }
  const parts: Array<Record<string, unknown>> = [];
  if (m.content) {
    parts.push({ type: 'text', text: m.content });
  }
  for (const att of m.attachments) {
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${att.mimeType};base64,${att.dataBase64}`,
      },
    });
  }
  return parts;
}

function formatAnthropicContent(m: ProviderMessage): unknown {
  if (!m.attachments || m.attachments.length === 0) {
    return m.content;
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const att of m.attachments) {
    parts.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: att.mimeType,
        data: att.dataBase64,
      },
    });
  }
  if (m.content) {
    parts.push({ type: 'text', text: m.content });
  }
  return parts;
}

async function readSseLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      onLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      onLine(line);
    }
  }
}

export async function streamModelResponse(params: {
  model: BrandedModel;
  messages: ProviderMessage[];
  systemInstruction?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
  callbacks: StreamCallbacks;
}): Promise<void> {
  const { model, messages, systemInstruction, signal, callbacks } = params;
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 25_000, 1_000), 60_000);
  const maxAttempts = Math.min(Math.max(params.maxAttempts ?? 1, 1), 2);
  const storedCreds = getModelCredentials(model.id);
  const catalogEntry = getProviderCatalogEntry(model.provider);

  if (!catalogEntry) {
    throw new ProviderExecutionError(`Unsupported provider: ${model.provider}`, {
      errorClass: 'configuration_error',
      healthStatus: 'configuration_error',
      retryable: false,
    });
  }

  if (catalogEntry.retired) {
    throw new ProviderExecutionError(
      catalogEntry.retiredNotice ?? `${catalogEntry.displayName} is retired and unsupported.`,
      {
        errorClass: 'configuration_error',
        healthStatus: 'configuration_error',
        retryable: false,
      }
    );
  }

  const hasImages = messages.some((m) => Array.isArray(m.attachments) && m.attachments.length > 0);
  if (hasImages && (!model.inputModalities.includes('image') || !catalogEntry.supportsVision)) {
    throw new ProviderExecutionError(
      `${model.displayName} (${catalogEntry.displayName}) does not support image attachments.`,
      {
        errorClass: 'validation_error',
        healthStatus: model.availability,
        retryable: false,
        httpStatus: 400,
      }
    );
  }

  const useStoredRowCreds = storedCreds.rowProvider === model.provider;
  const resolvedCreds = resolveProviderCredentials({
    provider: model.provider,
    overrideApiKey: useStoredRowCreds ? storedCreds.apiKey : undefined,
    hasEncryptedKey: useStoredRowCreds && Boolean(storedCreds.apiKey),
    customBaseUrl: useStoredRowCreds ? storedCreds.baseUrl : undefined,
  });

  if (!resolvedCreds.configured) {
    throw new ProviderExecutionError(
      `${model.displayName} is awaiting configuration: ${resolvedCreds.missingReason}.`,
      {
        errorClass: 'configuration_error',
        healthStatus: 'awaiting_config',
        retryable: false,
      }
    );
  }

  // 1. Google Gemini Native SDK Protocol
  if (catalogEntry.protocol === 'gemini') {
    const ai = createGeminiClient(resolvedCreds.apiKey);
    if (!ai) {
      throw new ProviderExecutionError(
        `${model.displayName} is awaiting configuration: GEMINI_API_KEY is not configured on the server.`,
        {
          errorClass: 'configuration_error',
          healthStatus: 'awaiting_config',
          retryable: false,
        }
      );
    }

    const contents = messages.map((m) => {
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
      if (m.attachments && m.attachments.length > 0) {
        for (const att of m.attachments) {
          parts.push({
            inlineData: {
              mimeType: att.mimeType,
              data: att.dataBase64,
            },
          });
        }
      }
      if (m.content) {
        parts.push({ text: m.content });
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });

    const thinkingLevel = mapThinkingLevel(model.thinkingPreset, model.upstreamModelId);
    const config: Record<string, unknown> = {};
    if (systemInstruction?.trim()) {
      config.systemInstruction = systemInstruction.trim();
    }
    if (thinkingLevel && (model.upstreamModelId.startsWith('gemini-3') || model.upstreamModelId.startsWith('gemini-4'))) {
      config.thinkingConfig = { thinkingLevel };
    }

    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) return;
      const attemptStart = Date.now();
      let emittedChunk = false;
      const { signal: attemptSignal, timeoutSignal } = createAttemptSignal(signal, timeoutMs);
      try {
        const stream = await ai.models.generateContentStream({
          model: model.upstreamModelId,
          contents,
          config: {
            ...config,
            abortSignal: attemptSignal,
          },
        });

        for await (const chunk of stream) {
          if (signal?.aborted) return;
          if (chunk.text) {
            if (!emittedChunk) {
              emittedChunk = true;
              callbacks.onFirstToken?.(Date.now() - attemptStart);
            }
            callbacks.onChunk(chunk.text);
          }
          if (chunk.usageMetadata) {
            callbacks.onUsage?.({
              inputTokens: chunk.usageMetadata.promptTokenCount,
              outputTokens: chunk.usageMetadata.candidatesTokenCount,
              cachedTokens: chunk.usageMetadata.cachedContentTokenCount,
            });
          }
        }
        if (!emittedChunk && !signal?.aborted) {
          throw new ProviderExecutionError(`${model.displayName} returned an empty stream response.`, {
            errorClass: 'provider_unavailable',
            healthStatus: 'temporarily_unavailable',
            retryable: true,
          });
        }
        return;
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) return;
        const timeoutErr = normalizeTimeoutOrAbortError({
          err,
          model,
          timeoutMs,
          userSignal: signal,
          timeoutSignal,
          partialEmitted: emittedChunk,
        });
        if (timeoutErr) {
          if (!emittedChunk && attempt < maxAttempts - 1) {
            await sleep(400, signal);
            continue;
          }
          throw timeoutErr;
        }
        if (err instanceof ProviderExecutionError) {
          err.partialEmitted = emittedChunk;
          if (!emittedChunk && err.retryable && attempt < maxAttempts - 1) {
            await sleep(400, signal);
            continue;
          }
          throw err;
        }
        const info = extractReadableError(err);
        const cls = classifyProviderError(info.message, info.status);
        const bodyRetryAfter = parseRetryAfterFromErrorMessage(info.message);
        if (!emittedChunk && info.retryable && attempt < maxAttempts - 1) {
          await sleep(400, signal);
          continue;
        }
        throw new ProviderExecutionError(
          info.status
            ? `${model.displayName} upstream error (${info.status}): ${info.message}`
            : `${model.displayName}: ${info.message}`,
          {
            ...cls,
            httpStatus: info.status,
            retryAfterMs: bodyRetryAfter,
            partialEmitted: emittedChunk,
          }
        );
      }
    }
    if (lastErr) {
      const info = extractReadableError(lastErr);
      const cls = classifyProviderError(info.message, info.status);
      throw new ProviderExecutionError(`${model.displayName}: ${info.message}`, {
        ...cls,
        httpStatus: info.status,
        retryAfterMs: parseRetryAfterFromErrorMessage(info.message),
      });
    }
    return;
  }

  // 2. OpenAI-Compatible Protocol (OpenAI, Mistral, xAI, AI21, Groq, Cerebras, SambaNova, Together, Fireworks, HF, Cloudflare, NVIDIA NIM, DeepInfra, Hosted OSS, OpenRouter)
  if (catalogEntry.protocol === 'openai-compatible') {
    const baseUrl = resolvedCreds.baseUrl;
    const apiKey = resolvedCreds.apiKey;
    if (!baseUrl) {
      throw new ProviderExecutionError(
        `${model.displayName} is awaiting configuration: ${resolvedCreds.missingReason}.`,
        {
          errorClass: 'configuration_error',
          healthStatus: 'awaiting_config',
          retryable: false,
        }
      );
    }

    const formattedMessages: Array<{ role: string; content: unknown }> = [];
    if (systemInstruction?.trim()) {
      formattedMessages.push({ role: 'system', content: systemInstruction.trim() });
    }
    for (const m of messages) {
      formattedMessages.push({ role: m.role, content: formatOpenAiContent(m) });
    }

    const isOpenAiReasoningModel = /^(o1|o3|o4|gpt-5)(-|$)/.test(model.upstreamModelId);
    const reasoningEffort =
      isOpenAiReasoningModel && model.thinkingPreset
        ? model.thinkingPreset === 'MINIMAL' || model.thinkingPreset === 'LOW'
          ? 'low'
          : model.thinkingPreset === 'MEDIUM'
            ? 'medium'
            : 'high'
        : undefined;

    const endpoint = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    const attemptStart = Date.now();
    const { signal: attemptSignal, timeoutSignal } = createAttemptSignal(signal, timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(catalogEntry.extraHeaders?.() ?? {}),
        },
        body: JSON.stringify({
          model: model.upstreamModelId,
          messages: formattedMessages,
          stream: true,
          ...(catalogEntry.supportsStreamOptionsUsage ? { stream_options: { include_usage: true } } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
        signal: attemptSignal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      const timeoutErr = normalizeTimeoutOrAbortError({
        err,
        model,
        timeoutMs,
        userSignal: signal,
        timeoutSignal,
      });
      if (timeoutErr) throw timeoutErr;
      const info = extractReadableError(err);
      const cls = classifyProviderError(info.message);
      throw new ProviderExecutionError(`${model.displayName} (${catalogEntry.displayName}): ${info.message}`, { ...cls });
    }

    if (!resp.ok || !resp.body) {
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
      const errText = await resp.text().catch(() => resp.statusText);
      const info = extractReadableError(errText);
      const cls = classifyProviderError(info.message || errText, resp.status);
      throw new ProviderExecutionError(
        `${model.displayName} (${catalogEntry.displayName}) upstream error (${resp.status}): ${info.message || errText}`,
        {
          ...cls,
          httpStatus: resp.status,
          retryAfterMs,
        }
      );
    }

    let emittedChunk = false;
    const processOpenAiLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') return;
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(dataStr) as Record<string, any>;
      } catch {
        return;
      }
      if (parsed.error) {
        const msg = String(parsed.error?.message ?? JSON.stringify(parsed.error));
        const cls = classifyProviderError(msg);
        throw new ProviderExecutionError(`${model.displayName}: ${msg}`, { ...cls, partialEmitted: emittedChunk });
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        if (!emittedChunk) {
          emittedChunk = true;
          callbacks.onFirstToken?.(Date.now() - attemptStart);
        }
        callbacks.onChunk(delta);
      } else if (Array.isArray(delta)) {
        const combined = delta
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .join('');
        if (combined.length > 0) {
          if (!emittedChunk) {
            emittedChunk = true;
            callbacks.onFirstToken?.(Date.now() - attemptStart);
          }
          callbacks.onChunk(combined);
        }
      }
      if (parsed.usage) {
        callbacks.onUsage?.({
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
          cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
        });
      }
    };

    try {
      await readSseLines(resp.body, processOpenAiLine);
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof ProviderExecutionError) {
        err.partialEmitted = emittedChunk;
        throw err;
      }
      const timeoutErr = normalizeTimeoutOrAbortError({
        err,
        model,
        timeoutMs,
        userSignal: signal,
        timeoutSignal,
        partialEmitted: emittedChunk,
      });
      if (timeoutErr) throw timeoutErr;
      const info = extractReadableError(err);
      const cls = classifyProviderError(info.message);
      throw new ProviderExecutionError(`${model.displayName}: ${info.message}`, {
        ...cls,
        partialEmitted: emittedChunk,
      });
    }

    if (!emittedChunk && !signal?.aborted) {
      throw new ProviderExecutionError(
        `${model.displayName} (${catalogEntry.displayName}) returned an empty probe response.`,
        {
          errorClass: 'provider_unavailable',
          healthStatus: 'temporarily_unavailable',
          retryable: true,
        }
      );
    }
    return;
  }

  // 3. Anthropic Messages API Protocol (with Prompt Caching & Multimodal Image Support)
  if (catalogEntry.protocol === 'anthropic') {
    const apiKey = resolvedCreds.apiKey;
    const baseUrl = resolvedCreds.baseUrl ?? 'https://api.anthropic.com';
    if (!apiKey) {
      throw new ProviderExecutionError(
        `${model.displayName} is awaiting configuration: requires ANTHROPIC_API_KEY.`,
        {
          errorClass: 'configuration_error',
          healthStatus: 'awaiting_config',
          retryable: false,
        }
      );
    }

    const trimmedSystem = systemInstruction?.trim() || '';
    const systemField = !trimmedSystem
      ? undefined
      : trimmedSystem.length >= 1024
        ? [{ type: 'text', text: trimmedSystem, cache_control: { type: 'ephemeral' } }]
        : trimmedSystem;

    const attemptStart = Date.now();
    const { signal: attemptSignal, timeoutSignal } = createAttemptSignal(signal, timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model.upstreamModelId,
          max_tokens: 4096,
          system: systemField,
          stream: true,
          messages: messages.map((m) => ({ role: m.role, content: formatAnthropicContent(m) })),
        }),
        signal: attemptSignal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      const timeoutErr = normalizeTimeoutOrAbortError({
        err,
        model,
        timeoutMs,
        userSignal: signal,
        timeoutSignal,
      });
      if (timeoutErr) throw timeoutErr;
      const info = extractReadableError(err);
      const cls = classifyProviderError(info.message);
      throw new ProviderExecutionError(`${model.displayName}: ${info.message}`, { ...cls });
    }

    if (!resp.ok || !resp.body) {
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
      const errText = await resp.text().catch(() => resp.statusText);
      const info = extractReadableError(errText);
      const cls = classifyProviderError(info.message || errText, resp.status);
      throw new ProviderExecutionError(
        `${model.displayName} upstream error (${resp.status}): ${info.message || errText}`,
        {
          ...cls,
          httpStatus: resp.status,
          retryAfterMs,
        }
      );
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let emittedChunk = false;

    const processAnthropicLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') return;
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(dataStr) as Record<string, any>;
      } catch {
        return;
      }
      if (parsed.type === 'error' && parsed.error) {
        const msg = String(parsed.error?.message ?? JSON.stringify(parsed.error));
        const cls = classifyProviderError(msg);
        throw new ProviderExecutionError(`${model.displayName}: ${msg}`, { ...cls, partialEmitted: emittedChunk });
      }
      if (parsed.type === 'message_start' && parsed.message?.usage) {
        inputTokens = Number(parsed.message.usage.input_tokens ?? inputTokens);
        cachedTokens = Number(parsed.message.usage.cache_read_input_tokens ?? cachedTokens);
      }
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        if (!emittedChunk) {
          emittedChunk = true;
          callbacks.onFirstToken?.(Date.now() - attemptStart);
        }
        callbacks.onChunk(parsed.delta.text);
      }
      if (parsed.type === 'message_delta' && parsed.usage) {
        if (parsed.usage.input_tokens !== undefined) {
          inputTokens = Number(parsed.usage.input_tokens);
        }
        if (parsed.usage.cache_read_input_tokens !== undefined) {
          cachedTokens = Number(parsed.usage.cache_read_input_tokens);
        }
        if (parsed.usage.output_tokens !== undefined) {
          outputTokens = Number(parsed.usage.output_tokens);
        }
        callbacks.onUsage?.({ inputTokens, outputTokens, cachedTokens });
      }
    };

    try {
      await readSseLines(resp.body, processAnthropicLine);
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof ProviderExecutionError) {
        err.partialEmitted = emittedChunk;
        throw err;
      }
      const timeoutErr = normalizeTimeoutOrAbortError({
        err,
        model,
        timeoutMs,
        userSignal: signal,
        timeoutSignal,
        partialEmitted: emittedChunk,
      });
      if (timeoutErr) throw timeoutErr;
      const info = extractReadableError(err);
      const cls = classifyProviderError(info.message);
      throw new ProviderExecutionError(`${model.displayName}: ${info.message}`, {
        ...cls,
        partialEmitted: emittedChunk,
      });
    }

    if (!emittedChunk && !signal?.aborted) {
      throw new ProviderExecutionError(`${model.displayName} (Anthropic) returned an empty response.`, {
        errorClass: 'provider_unavailable',
        healthStatus: 'temporarily_unavailable',
        retryable: true,
      });
    }
    return;
  }

  // 4. Cohere v2 Native Streaming Protocol (/v2/chat)
  if (catalogEntry.protocol === 'cohere-v2') {
    const apiKey = resolvedCreds.apiKey;
    const baseUrl = resolvedCreds.baseUrl ?? 'https://api.cohere.com';
    if (!apiKey) {
      throw new ProviderExecutionError(
        `${model.displayName} is awaiting configuration: requires COHERE_API_KEY.`,
        {
          errorClass: 'configuration_error',
          healthStatus: 'awaiting_config',
          retryable: false,
        }
      );
    }

    const cohereMessages: Array<{ role: string; content: string }> = [];
    if (systemInstruction?.trim()) {
      cohereMessages.push({ role: 'system', content: systemInstruction.trim() });
    }
    for (const m of messages) {
      cohereMessages.push({ role: m.role, content: m.content });
    }

    const endpoint = baseUrl.endsWith('/v2/chat')
      ? baseUrl
      : `${baseUrl.replace(/\/$/, '')}/v2/chat`;

    const attemptStart = Date.now();
    const { signal: attemptSignal, timeoutSignal } = createAttemptSignal(signal, timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.upstreamModelId,
          stream: true,
          messages: cohereMessages,
        }),
        signal: attemptSignal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      const timeoutErr = normalizeTimeoutOrAbortError({
        err,
        model,
        timeoutMs,
        userSignal: signal,
        timeoutSignal,
      });
      if (timeoutErr) throw timeoutErr;
      const info = extractReadableError(err);
      const cls = classifyProviderError(info.message);
      throw new ProviderExecutionError(`${model.displayName} (Cohere): ${info.message}`, { ...cls });
    }

    if (!resp.ok || !resp.body) {
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
      const errText = await resp.text().catch(() => resp.statusText);
      const info = extractReadableError(errText);
      const cls = classifyProviderError(info.message || errText, resp.status);
      throw new ProviderExecutionError(
        `${model.displayName} (Cohere) upstream error (${resp.status}): ${info.message || errText}`,
        {
          ...cls,
          httpStatus: resp.status,
          retryAfterMs,
        }
      );
    }

    let emittedChunk = false;
    const processCohereLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') return;
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(dataStr) as Record<string, any>;
      } catch {
        return;
      }
      if (parsed.type === 'error' || parsed.message?.includes?.('error')) {
        if (parsed.error) {
          const msg = String(parsed.error?.message ?? JSON.stringify(parsed.error));
          const cls = classifyProviderError(msg);
          throw new ProviderExecutionError(`${model.displayName}: ${msg}`, {
            ...cls,
            partialEmitted: emittedChunk,
          });
        }
      }
      if (parsed.type === 'content-delta') {
        const text = parsed.delta?.message?.content?.text;
        if (typeof text === 'string' && text.length > 0) {
          if (!emittedChunk) {
            emittedChunk = true;
            callbacks.onFirstToken?.(Date.now() - attemptStart);
          }
          callbacks.onChunk(text);
        }
      }
      if (parsed.type === 'message-end' && parsed.delta?.usage) {
        const tok = parsed.delta.usage.tokens ?? parsed.delta.usage.billed_units;
        if (tok) {
          callbacks.onUsage?.({
            inputTokens: Number(tok.input_tokens ?? 0),
            outputTokens: Number(tok.output_tokens ?? 0),
            cachedTokens: 0,
          });
        }
      }
    };

    try {
      await readSseLines(resp.body, processCohereLine);
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof ProviderExecutionError) {
        err.partialEmitted = emittedChunk;
        throw err;
      }
      const timeoutErr = normalizeTimeoutOrAbortError({
        err,
        model,
        timeoutMs,
        userSignal: signal,
        timeoutSignal,
        partialEmitted: emittedChunk,
      });
      if (timeoutErr) throw timeoutErr;
      const info = extractReadableError(err);
      const cls = classifyProviderError(info.message);
      throw new ProviderExecutionError(`${model.displayName}: ${info.message}`, {
        ...cls,
        partialEmitted: emittedChunk,
      });
    }

    if (!emittedChunk && !signal?.aborted) {
      throw new ProviderExecutionError(`${model.displayName} (Cohere) returned an empty response.`, {
        errorClass: 'provider_unavailable',
        healthStatus: 'temporarily_unavailable',
        retryable: true,
      });
    }
    return;
  }

  throw new ProviderExecutionError(`Unsupported provider protocol: ${catalogEntry.protocol}`, {
    errorClass: 'configuration_error',
    healthStatus: 'configuration_error',
    retryable: false,
  });
}

// Valid 1x1 emerald PNG for multimodal connectivity & image-format verification
const PROBE_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

export async function testProviderConnection(
  model: BrandedModel,
  options?: { prompt?: string; testImage?: boolean; timeoutMs?: number }
): Promise<{
  ok: boolean;
  latencyMs: number;
  ttftMs: number | null;
  httpStatus: number | null;
  healthStatus: AvailabilityStatus;
  errorClass: ErrorClass | null;
  retryAfterMs?: number;
  message: string;
  sampleText?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
}> {
  const start = Date.now();
  let ttftMs: number | null = null;
  let usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | undefined;
  let sampleText = '';

  const probeModel: BrandedModel = {
    ...model,
    thinkingPreset: 'MINIMAL',
  };

  try {
    await streamModelResponse({
      model: probeModel,
      timeoutMs: options?.timeoutMs ?? 35_000,
      maxAttempts: 2,
      messages: [
        {
          role: 'user',
          content: options?.prompt ?? 'Respond with exactly: OK',
          attachments: options?.testImage
            ? [
                {
                  mimeType: 'image/png',
                  dataBase64: PROBE_1X1_PNG_BASE64,
                  name: 'probe.png',
                  sizeBytes: 68,
                },
              ]
            : undefined,
        },
      ],
      callbacks: {
        onFirstToken: (ms) => {
          ttftMs = ms;
        },
        onChunk: (text) => {
          sampleText += text;
        },
        onUsage: (u) => {
          usage = u;
        },
      },
    });
    const latencyMs = Date.now() - start;
    const ok = sampleText.trim().length > 0;
    const healthStatus: AvailabilityStatus = !ok
      ? 'temporarily_unavailable'
      : latencyMs > 6000
      ? 'slow'
      : 'operational';

    return {
      ok,
      latencyMs,
      ttftMs,
      httpStatus: ok ? 200 : null,
      healthStatus,
      errorClass: ok ? null : 'provider_unavailable',
      message: ok
        ? `Verified live response from ${model.provider}/${model.upstreamModelId} (${latencyMs}ms)`
        : `${model.displayName} returned an empty probe response.`,
      sampleText: sampleText.trim().slice(0, 400),
      usage,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (err instanceof ProviderExecutionError) {
      // Never classify a failed probe as 'slow', 'connected', or 'operational'.
      const failedStatus: AvailabilityStatus =
        err.healthStatus === 'slow' || err.healthStatus === 'operational' || err.healthStatus === 'connected'
          ? 'temporarily_unavailable'
          : err.healthStatus;
      return {
        ok: false,
        latencyMs,
        ttftMs,
        httpStatus: err.httpStatus ?? null,
        healthStatus: failedStatus,
        errorClass: err.errorClass,
        retryAfterMs: err.retryAfterMs,
        message: err.message,
      };
    }
    const msg = err instanceof Error ? err.message : 'Connection verification failed';
    const cls = classifyProviderError(msg);
    return {
      ok: false,
      latencyMs,
      ttftMs,
      httpStatus: null,
      healthStatus:
        cls.healthStatus === 'slow' || cls.healthStatus === 'operational' || cls.healthStatus === 'connected'
          ? 'temporarily_unavailable'
          : cls.healthStatus,
      errorClass: cls.errorClass,
      message: msg,
    };
  }
}

