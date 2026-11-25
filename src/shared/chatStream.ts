import type {
  ChatMessage,
  ErrorClass,
  KnowledgeCitation,
  OrchestratorMode,
  PerModelDailyQuotaEntry,
} from './types';

export interface ChatStreamMetaEvent {
  conversationId: string;
  userMessageId?: string;
  modelId?: string;
  provider?: string;
  resolvedMode?: Exclude<OrchestratorMode, 'auto'>;
  fallbackFromModelId?: string;
  fallbackReason?: string;
  fallbackErrorClass?: ErrorClass;
  fallbackNotice?: string;
  citations?: KnowledgeCitation[];
}

export interface ChatStreamDoneEvent {
  conversationId: string;
  messageId?: string;
  modelId?: string;
  fallbackUsed?: string;
  aborted?: boolean;
  citations?: KnowledgeCitation[];
  quota?: {
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
  timingsMs?: Record<string, number>;
}

export interface ChatStreamErrorEventMeta {
  conversationId?: string;
  partialSaved?: boolean;
  messageId?: string;
  unexpectedEof?: boolean;
}

export type ChatActivityStage =
  | 'analyzing_files'
  | 'searching'
  | 'using_tools'
  | 'reading_sources'
  | 'thinking'
  | 'generating';

export interface ChatStreamStatusEvent {
  stage: ChatActivityStage;
  detail?: string;
}

export interface SseStreamHandlers {
  onMeta: (meta: ChatStreamMetaEvent) => void;
  onStatus?: (status: ChatStreamStatusEvent) => void;
  onChunk: (text: string) => void;
  onDone: (done: ChatStreamDoneEvent) => void;
  onError: (err: string, meta?: ChatStreamErrorEventMeta) => void;
}

export interface SseStreamSummary {
  receivedMeta: boolean;
  receivedDone: boolean;
  receivedError: boolean;
  chunkCount: number;
  parseErrorCount: number;
  lastParseError: string | null;
}

export function createSseStreamProcessor(handlers: SseStreamHandlers) {
  let buffer = '';
  let currentEvent = '';
  let dataLines: string[] = [];
  let receivedMeta = false;
  let receivedDone = false;
  let receivedError = false;
  let chunkCount = 0;
  let parseErrorCount = 0;
  let lastParseError: string | null = null;

  const dispatchEvent = () => {
    if (dataLines.length === 0) {
      currentEvent = '';
      return;
    }

    const eventName = currentEvent || 'message';
    const rawData = dataLines.join('\n').trim();
    currentEvent = '';
    dataLines = [];

    if (!rawData || rawData === '[DONE]') {
      return;
    }

    try {
      const payload = JSON.parse(rawData) as Record<string, unknown>;
      if (eventName === 'meta') {
        receivedMeta = true;
        handlers.onMeta(payload as unknown as ChatStreamMetaEvent);
      } else if (eventName === 'status') {
        if (typeof payload.stage === 'string' && handlers.onStatus) {
          handlers.onStatus({
            stage: payload.stage as ChatActivityStage,
            detail: typeof payload.detail === 'string' ? payload.detail : undefined,
          });
        }
      } else if (eventName === 'chunk') {
        chunkCount += 1;
        handlers.onChunk(typeof payload.text === 'string' ? payload.text : '');
      } else if (eventName === 'done') {
        receivedDone = true;
        handlers.onDone(payload as unknown as ChatStreamDoneEvent);
      } else if (eventName === 'error') {
        receivedError = true;
        const msg =
          typeof payload.error === 'string' && payload.error.trim().length > 0
            ? payload.error
            : 'Model streaming error occurred.';
        handlers.onError(msg, {
          conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : undefined,
          partialSaved: typeof payload.partialSaved === 'boolean' ? payload.partialSaved : undefined,
          messageId: typeof payload.messageId === 'string' ? payload.messageId : undefined,
        });
      }
    } catch (err) {
      parseErrorCount += 1;
      lastParseError = err instanceof Error ? err.message : 'Malformed SSE JSON frame';
      if (eventName === 'error') {
        receivedError = true;
        handlers.onError(rawData || 'Model streaming error occurred.');
      } else if (eventName === 'done') {
        receivedDone = true;
        handlers.onError('Stream ended with a malformed completion payload.');
      }
    }
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatchEvent();
      return;
    }
    if (line.startsWith(':')) {
      return;
    }
    if (line.startsWith('event:')) {
      if (dataLines.length > 0) {
        dispatchEvent();
      }
      currentEvent = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      const rest = line.slice(5);
      dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest);
    }
  };

  const feed = (chunkText: string) => {
    if (!chunkText) return;
    buffer += chunkText;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
    }
  };

  const finalize = (): SseStreamSummary => {
    if (buffer.length > 0) {
      const remainder = buffer;
      buffer = '';
      processLine(remainder);
    }
    if (dataLines.length > 0) {
      dispatchEvent();
    }
    return {
      receivedMeta,
      receivedDone,
      receivedError,
      chunkCount,
      parseErrorCount,
      lastParseError,
    };
  };

  return {
    feed,
    finalize,
    getSummary: (): SseStreamSummary => ({
      receivedMeta,
      receivedDone,
      receivedError,
      chunkCount,
      parseErrorCount,
      lastParseError,
    }),
  };
}

export async function consumeSseReadableStream(
  body: ReadableStream<Uint8Array>,
  handlers: SseStreamHandlers,
  signal?: AbortSignal
): Promise<SseStreamSummary> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const processor = createSseStreamProcessor(handlers);

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        processor.feed(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    reader.releaseLock();
  }

  const trailing = decoder.decode();
  if (trailing) {
    processor.feed(trailing);
  }
  const summary = processor.finalize();

  if (!signal?.aborted && !summary.receivedDone && !summary.receivedError) {
    const reason =
      summary.chunkCount > 0
        ? 'Connection interrupted before generation completed. Partial response was preserved.'
        : summary.parseErrorCount > 0
        ? 'Stream terminated after receiving malformed server event data.'
        : 'Connection closed unexpectedly before receiving a response from the assistant.';
    handlers.onError(reason, { unexpectedEof: true });
  }

  return summary;
}

export interface ReconcileMessagesInput {
  dbMessages: ChatMessage[] | null;
  fallbackMessages: ChatMessage[];
  streamedText: string;
  conversationId: string;
  modelId: string;
  localPartialId: string;
  userMessageIdFromServer?: string;
  serverAssistantMessageId?: string;
}

export function reconcileStreamMessages(input: ReconcileMessagesInput): ChatMessage[] {
  const base = input.dbMessages !== null ? [...input.dbMessages] : [...input.fallbackMessages];
  const trimmedPartial = input.streamedText.trim();
  if (!trimmedPartial) {
    return base;
  }

  if (input.serverAssistantMessageId && base.some((m) => m.id === input.serverAssistantMessageId)) {
    return base;
  }

  if (input.userMessageIdFromServer) {
    const userIdx = base.findIndex((m) => m.id === input.userMessageIdFromServer);
    if (userIdx >= 0 && base.slice(userIdx + 1).some((m) => m.role === 'assistant')) {
      return base;
    }
  }

  const lastMsg = base[base.length - 1];
  if (
    lastMsg &&
    lastMsg.role === 'assistant' &&
    (lastMsg.id === input.localPartialId || lastMsg.content.trim() === trimmedPartial)
  ) {
    return base;
  }

  base.push({
    id: input.localPartialId,
    conversationId: input.conversationId || 'pending',
    role: 'assistant',
    content: input.streamedText,
    modelId: input.modelId,
    createdAt: new Date().toISOString(),
  });
  return base;
}

export interface SharedTranscriptMessage {
  role: string;
  content: string;
  modelId?: string;
  createdAt?: string;
}

export function parseSharedTranscriptSafely(raw: string): {
  ok: boolean;
  messages: SharedTranscriptMessage[];
  error: string | null;
} {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        messages: [],
        error: 'Shared conversation transcript is malformed or invalid.',
      };
    }
    const sanitized: SharedTranscriptMessage[] = parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        role: typeof item.role === 'string' && item.role ? item.role : 'assistant',
        content: typeof item.content === 'string' ? item.content : String(item.content ?? ''),
        modelId: typeof item.modelId === 'string' ? item.modelId : undefined,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
      }));
    return { ok: true, messages: sanitized, error: null };
  } catch {
    return {
      ok: false,
      messages: [],
      error: 'Shared conversation snapshot data is corrupted and cannot be displayed.',
    };
  }
}
