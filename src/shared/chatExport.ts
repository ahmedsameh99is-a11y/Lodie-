import type { ChatMessage, Conversation } from './types';

export function formatConversationMarkdown(
  conversation: Pick<Conversation, 'title' | 'modelId' | 'createdAt'>,
  messages: Array<Pick<ChatMessage, 'role' | 'content' | 'modelId' | 'createdAt'>>
): string {
  const header = [
    `# ${conversation.title}`,
    `- Model: ${conversation.modelId}`,
    `- Exported: ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ].join('\n');

  const body = messages
    .map((m) => {
      const speaker = m.role === 'user' ? 'User' : `LOODY (${m.modelId ?? conversation.modelId})`;
      return `### ${speaker}\n\n${m.content}\n`;
    })
    .join('\n---\n\n');

  return `${header}${body}`;
}

export function formatConversationJson(
  conversation: Pick<Conversation, 'id' | 'title' | 'modelId' | 'createdAt' | 'updatedAt'>,
  messages: Array<Pick<ChatMessage, 'id' | 'role' | 'content' | 'modelId' | 'provider' | 'inputTokens' | 'outputTokens' | 'createdAt'>>
): string {
  return JSON.stringify(
    {
      platform: 'LOODY',
      exportedAt: new Date().toISOString(),
      conversation,
      messages,
    },
    null,
    2
  );
}

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'html',
  'css',
  'xml',
  'yaml',
  'yml',
  'sql',
  'log',
  'env',
  'sh',
]);

export function isSupportedTextDocument(filename: string, mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript'
  ) {
    return true;
  }
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(ext);
}

export function sanitizeExtractedText(raw: string, maxChars = 16000): string {
  const cleaned = raw.replace(/\u0000/g, '').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n\n[Truncated to ${maxChars.toLocaleString()} characters for context budget]`;
}

export function extractLanguageExtension(languageClass?: string): string {
  const clean = (languageClass ?? '').replace(/^language-/, '').toLowerCase();
  const map: Record<string, string> = {
    typescript: 'ts',
    ts: 'ts',
    tsx: 'tsx',
    javascript: 'js',
    js: 'js',
    jsx: 'jsx',
    python: 'py',
    py: 'py',
    json: 'json',
    html: 'html',
    css: 'css',
    sql: 'sql',
    bash: 'sh',
    sh: 'sh',
    yaml: 'yml',
    markdown: 'md',
  };
  return map[clean] ?? 'txt';
}

export function buildConversationMarkdown(opts: {
  title: string;
  modelId: string;
  createdAt?: string;
  messages: Array<Pick<ChatMessage, 'role' | 'content' | 'modelId' | 'createdAt'>>;
}): string {
  return formatConversationMarkdown(
    {
      title: opts.title,
      modelId: opts.modelId,
      createdAt: opts.createdAt ?? new Date().toISOString(),
    },
    opts.messages
  );
}

export function buildConversationJson(opts: {
  id?: string;
  title: string;
  modelId: string;
  createdAt?: string;
  updatedAt?: string;
  messages: Array<
    Pick<ChatMessage, 'id' | 'role' | 'content' | 'modelId' | 'provider' | 'inputTokens' | 'outputTokens' | 'createdAt'>
  >;
}): string {
  const now = new Date().toISOString();
  return formatConversationJson(
    {
      id: opts.id ?? 'export',
      title: opts.title,
      modelId: opts.modelId,
      createdAt: opts.createdAt ?? now,
      updatedAt: opts.updatedAt ?? now,
    },
    opts.messages
  );
}

export function triggerBrowserDownload(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8'
): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

