import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { classifyProviderError } from '../../src/shared/orchestrator';
import type { AvailabilityStatus, BrandedModel, ChatAttachment, ErrorClass } from '../../src/shared/types';
import { getModelCredentials } from '../db';

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
}

export interface StreamCallbacks {
  onChunk: (text: string) => void;
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

  constructor(
    message: string,
    meta: { errorClass: ErrorClass; healthStatus: AvailabilityStatus; retryable: boolean; httpStatus?: number }
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
    this.errorClass = meta.errorClass;
    this.healthStatus = meta.healthStatus;
    this.retryable = meta.retryable;
    this.httpStatus = meta.httpStatus;
  }
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

function mapThinkingLevel(preset?: BrandedModel['thinkingPreset'], upstreamModelId?: string): ThinkingLevel | undefined {
  if (!preset) return undefined;
  const isGemini4 = upstreamModelId?.startsWith('gemini-4-');
  switch (preset) {
    case 'MINIMAL':
      return isGemini4 ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL;
    case 'LOW':
      return ThinkingLevel.LOW;
    case 'MEDIUM':
      return ThinkingLevel.MEDIUM;
    case 'HIGH':
      return ThinkingLevel.HIGH;
    case 'XHIGH':
      if (upstreamModelId === 'gemini-4-hydrogen' || upstreamModelId === 'gemini-4-neon') {
        return ThinkingLevel.XHIGH;
      }
      return ThinkingLevel.HIGH;
    default:
      return undefined;
  }
}

function extractReadableError(err: unknown): { message: string; retryable: boolean; status?: number } {
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
}): ProviderExecutionError | null {
  if (params.userSignal?.aborted) {
    return null; // Caller intentionally aborted
  }
  const errName = (params.err as { name?: string })?.name;
  const timedOut =
    Boolean(params.timeoutSignal?.aborted) ||
    errName === 'TimeoutError';

  if (timedOut) {
    const secs = Math.round(params.timeoutMs / 1000);
    return new ProviderExecutionError(
      `${params.model.displayName} timed out after ${secs}s waiting for ${params.model.provider}/${params.model.upstreamModelId}.`,
      {
        errorClass: 'latency',
        healthStatus: 'temporarily_unavailable',
        retryable: true,
        httpStatus: 504,
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
  const requestedModel = params.upstreamModelId ?? 'gemini-4-hydrogen';
  const candidates =
    params.allowFallback !== false && requestedModel === 'gemini-4-hydrogen'
      ? ['gemini-4-hydrogen', 'gemini-3.1-flash-lite']
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
  const creds = getModelCredentials(model.id);

  // Pre-routing capability validation: never dispatch image payloads to text-only models
  const hasImages = messages.some((m) => Array.isArray(m.attachments) && m.attachments.length > 0);
  if (hasImages && !model.inputModalities.includes('image')) {
    throw new ProviderExecutionError(
      `${model.displayName} does not support image attachments.`,
      {
        errorClass: 'validation_error',
        healthStatus: model.availability,
        retryable: false,
        httpStatus: 400,
      }
    );
  }

  if (model.provider === 'gemini') {
    const ai = createGeminiClient(creds.apiKey);
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
          if (signal?.aborted) {
            return;
          }
          if (chunk.text) {
            emittedChunk = true;
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
        });
        if (timeoutErr) {
          if (!emittedChunk && attempt < maxAttempts - 1) {
            await sleep(400, signal);
            continue;
          }
          throw timeoutErr;
        }
        const info = extractReadableError(err);
        const cls = classifyProviderError(info.message, info.status);
        if (!emittedChunk && info.retryable && attempt < maxAttempts - 1) {
          await sleep(400, signal);
          continue;
        }
        throw new ProviderExecutionError(
          info.status
            ? `${model.displayName} upstream error (${info.status}): ${info.message}`
            : `${model.displayName}: ${info.message}`,
          { ...cls, httpStatus: info.status }
        );
      }
    }
    if (lastErr) {
      const info = extractReadableError(lastErr);
      const cls = classifyProviderError(info.message, info.status);
      throw new ProviderExecutionError(`${model.displayName}: ${info.message}`, { ...cls, httpStatus: info.status });
    }
    return;
  }

  if (model.provider === 'openai-compatible' || model.provider === 'hosted-oss') {
    const apiKey =
      creds.apiKey ??
      (model.provider === 'hosted-oss' ? process.env.HOSTED_OSS_API_KEY : process.env.OPENAI_API_KEY);
    const baseUrl =
      creds.baseUrl ??
      (model.provider === 'hosted-oss'
        ? process.env.HOSTED_OSS_BASE_URL
        : process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1');

    if (!baseUrl || (!apiKey && model.provider === 'openai-compatible')) {
      throw new ProviderExecutionError(
        `${model.displayName} is awaiting configuration: requires ${
          model.provider === 'hosted-oss' ? 'HOSTED_OSS_BASE_URL' : 'OPENAI_API_KEY'
        }.`,
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
      formattedMessages.push({ role: m.role, content: m.content });
    }

    const { signal: attemptSignal, timeoutSignal } = createAttemptSignal(signal, timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: model.upstreamModelId,
          messages: formattedMessages,
          stream: true,
          stream_options: { include_usage: true },
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
      const errText = await resp.text().catch(() => resp.statusText);
      const info = extractReadableError(errText);
      const cls = classifyProviderError(info.message || errText, resp.status);
      throw new ProviderExecutionError(`${model.displayName} upstream error (${resp.status}): ${info.message || errText}`, {
        ...cls,
        httpStatus: resp.status,
      });
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
        throw new ProviderExecutionError(`${model.displayName}: ${msg}`, { ...cls });
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        callbacks.onChunk(delta);
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
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          processOpenAiLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          processOpenAiLine(line);
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof ProviderExecutionError) throw err;
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
    return;
  }

  if (model.provider === 'anthropic-compatible') {
    const apiKey = creds.apiKey ?? process.env.ANTHROPIC_API_KEY;
    const baseUrl = creds.baseUrl ?? 'https://api.anthropic.com';
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
          system: systemInstruction?.trim() || undefined,
          stream: true,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
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
      const errText = await resp.text().catch(() => resp.statusText);
      const info = extractReadableError(errText);
      const cls = classifyProviderError(info.message || errText, resp.status);
      throw new ProviderExecutionError(
        `${model.displayName} upstream error (${resp.status}): ${info.message || errText}`,
        {
          ...cls,
          httpStatus: resp.status,
        }
      );
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

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
        throw new ProviderExecutionError(`${model.displayName}: ${msg}`, { ...cls });
      }
      if (parsed.type === 'message_start' && parsed.message?.usage?.input_tokens) {
        inputTokens = parsed.message.usage.input_tokens;
      }
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        callbacks.onChunk(parsed.delta.text);
      }
      if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
        outputTokens = parsed.usage.output_tokens;
        callbacks.onUsage?.({ inputTokens, outputTokens, cachedTokens: 0 });
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          processAnthropicLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          processAnthropicLine(line);
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof ProviderExecutionError) throw err;
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
    return;
  }

  throw new ProviderExecutionError(`Unsupported provider: ${model.provider}`, {
    errorClass: 'configuration_error',
    healthStatus: 'configuration_error',
    retryable: false,
  });
}

export async function testProviderConnection(model: BrandedModel): Promise<{
  ok: boolean;
  latencyMs: number;
  healthStatus: AvailabilityStatus;
  errorClass: ErrorClass | null;
  message: string;
}> {
  const start = Date.now();
  try {
    let sampleText = '';
    await streamModelResponse({
      model,
      timeoutMs: 10_000,
      maxAttempts: 1,
      messages: [{ role: 'user', content: 'Respond with exactly: OK' }],
      callbacks: {
        onChunk: (text) => {
          sampleText += text;
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
      healthStatus,
      errorClass: ok ? null : 'provider_unavailable',
      message: ok
        ? `Verified live response from ${model.provider}/${model.upstreamModelId} (${latencyMs}ms)`
        : `${model.displayName} returned an empty probe response.`,
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
        healthStatus: failedStatus,
        errorClass: err.errorClass,
        message: err.message,
      };
    }
    const msg = err instanceof Error ? err.message : 'Connection verification failed';
    const cls = classifyProviderError(msg);
    return {
      ok: false,
      latencyMs,
      healthStatus:
        cls.healthStatus === 'slow' || cls.healthStatus === 'operational' || cls.healthStatus === 'connected'
          ? 'temporarily_unavailable'
          : cls.healthStatus,
      errorClass: cls.errorClass,
      message: msg,
    };
  }
}
