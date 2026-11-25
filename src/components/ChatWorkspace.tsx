import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import {
  ArrowUp,
  Plus,
  Camera,
  Plug,
  Loader2,
  Square,
  ImagePlus,
  FilePlus2,
  Copy,
  Check,
  RotateCcw,
  Pencil,
  Search,
  ChevronDown,
  ChevronRight,
  X,
  AlertCircle,
  Download,
  Share2,
  PanelRight,
  Mic,
  MicOff,
  Wrench,
  Trash2,
  RefreshCw,
  Volume2,
  VolumeX,
  BookOpen,
} from 'lucide-react';
import { ApiError, api, streamChat } from '../lib/api';
import { buildConversationJson, buildConversationMarkdown, triggerBrowserDownload } from '../shared/chatExport';
import { type ChatActivityStage, reconcileStreamMessages } from '../shared/chatStream';
import { t } from '../shared/i18n';
import { getModelStatusMeta } from '../shared/modelRegistry';
import { canAccessModel } from '../shared/quotas';
import { toSafeHref, toSafeMarkdownUrl } from '../shared/safeUrl';
import type {
  AppLanguage,
  BrandedModel,
  BuiltinTool,
  ChatAttachment,
  ChatMessage,
  Conversation,
  DocumentAttachment,
  OrchestratorMode,
  Project,
  ProjectFileRecord,
  PublicUser,
} from '../shared/types';
import { InlineMarkdownErrorBoundary } from './ErrorBoundary';
import { LoodyLogo } from './LoodyLogo';

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex, rehypeHighlight];

function extractNodeText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractNodeText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractNodeText(node.props.children);
  }
  return '';
}

const CodeBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [copied, setCopied] = useState(false);
  const codeStr = extractNodeText(children);

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-zinc-200 dark:border-emerald-500/20 bg-zinc-50 dark:bg-[#050706]">
      <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/10 bg-zinc-100/80 dark:bg-[#0A0E0C] px-3 py-1.5 text-[11px] text-zinc-500">
        <span className="font-mono">code</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(codeStr).catch(() => null);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="inline-flex items-center gap-1 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            type="button"
            onClick={() => triggerBrowserDownload('snippet.txt', codeStr, 'text/plain;charset=utf-8')}
            className="inline-flex items-center gap-1 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer"
          >
            <Download className="w-3 h-3" />
            <span>Download</span>
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-3.5 text-xs font-mono leading-relaxed">{children}</pre>
    </div>
  );
};

interface MemoMessageBubbleProps {
  message: ChatMessage;
  language: AppLanguage;
  authorLabel: string;
  isLastAssistant: boolean;
  isCopied: boolean;
  isSpeaking: boolean;
  isExpanded: boolean;
  isEditing: boolean;
  editingText: string;
  isCitationOpen: boolean;
  streaming: boolean;
  markdownComponents: Components;
  onCopy: (id: string, text: string) => void;
  onToggleSpeak: (id: string, text: string) => void;
  onToggleExpand: (id: string, nextExpanded: boolean) => void;
  onToggleCitation: (id: string) => void;
  onStartEdit: (id: string, content: string) => void;
  onChangeEditingText: (val: string) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onRegenerate: () => void;
  onContinue: () => void;
}

const MemoMessageBubble = React.memo<MemoMessageBubbleProps>(
  ({
    message: m,
    language,
    authorLabel,
    isLastAssistant,
    isCopied,
    isSpeaking,
    isExpanded,
    isEditing,
    editingText,
    isCitationOpen,
    streaming,
    markdownComponents,
    onCopy,
    onToggleSpeak,
    onToggleExpand,
    onToggleCitation,
    onStartEdit,
    onChangeEditingText,
    onSaveEdit,
    onCancelEdit,
    onRegenerate,
    onContinue,
  }) => {
    const isLong = m.content.length > 2200;
    const displayBody = isLong && !isExpanded ? `${m.content.slice(0, 1200)}...` : m.content;

    return (
      <article
        className={`rounded-2xl p-4 sm:p-5 transition-colors ${
          m.role === 'user'
            ? 'bg-emerald-50/80 dark:bg-[#101A15] border border-emerald-500/25 ms-auto max-w-[90%] sm:max-w-[78%] shadow-xs'
            : 'bg-white dark:bg-[#0A0E0C] border border-zinc-200/90 dark:border-white/8 shadow-xs'
        }`}
      >
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">{authorLabel}</span>
          {m.role === 'assistant' && typeof m.outputTokens === 'number' && (
            <span className="font-mono tabular-nums text-[11px] text-zinc-400">
              {m.inputTokens} in · {m.outputTokens} out ·{' '}
              {m.tokenAccountingType === 'provider_reported' ? 'Exact' : 'Est.'}
            </span>
          )}
        </div>

        {m.attachments && m.attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {m.attachments.map((att, aIdx) => (
              <span
                key={aIdx}
                className="rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#050706] px-2 py-1 text-[11px] text-zinc-600 dark:text-zinc-300"
              >
                {att.name}
              </span>
            ))}
          </div>
        )}

        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editingText}
              onChange={(e) => onChangeEditingText(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-emerald-500/40 bg-white dark:bg-[#050706] p-3 text-sm text-zinc-900 dark:text-white focus:outline-none"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onSaveEdit(m.id)}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 min-h-[36px] cursor-pointer"
              >
                {t(language, 'saveAndResend')}
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                className="rounded-lg border border-zinc-300 dark:border-white/10 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 min-h-[36px] cursor-pointer"
              >
                {t(language, 'cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="prose prose-zinc dark:prose-invert prose-sm max-w-none leading-relaxed prose-code:text-emerald-700 dark:prose-code:text-emerald-300">
            <InlineMarkdownErrorBoundary fallbackText={displayBody} resetKey={displayBody}>
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                urlTransform={toSafeMarkdownUrl}
                components={markdownComponents}
              >
                {displayBody}
              </ReactMarkdown>
            </InlineMarkdownErrorBoundary>
          </div>
        )}

        {isLong && (
          <button
            type="button"
            onClick={() => onToggleExpand(m.id, !isExpanded)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 cursor-pointer"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            <span>{isExpanded ? 'Collapse long response' : 'Expand full response'}</span>
          </button>
        )}

        {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
          <div className="mt-3 rounded-xl border border-emerald-500/20 bg-zinc-50 dark:bg-[#050706] p-3 text-xs space-y-2">
            <button
              type="button"
              onClick={() => onToggleCitation(m.id)}
              className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300 cursor-pointer"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>
                {m.citations.length} Knowledge Source{m.citations.length === 1 ? '' : 's'} Cited
              </span>
            </button>
            {isCitationOpen && (
              <div className="space-y-1.5 pt-1 border-t border-zinc-200 dark:border-white/10">
                {m.citations.map((c) => (
                  <div key={c.chunkId} className="rounded-lg bg-white dark:bg-[#0D110F] p-2 border border-zinc-200 dark:border-white/5">
                    <div className="flex items-center justify-between text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                      <span>{c.title}</span>
                      <span>{c.retrievalMethod} · {c.score.toFixed(2)}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400 line-clamp-2">{c.snippet}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-100 dark:border-white/5">
          <button
            type="button"
            onClick={() => onCopy(m.id, m.content)}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
          >
            {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{isCopied ? t(language, 'copied') : t(language, 'copy')}</span>
          </button>

          {m.role === 'assistant' && (
            <button
              type="button"
              onClick={() => onToggleSpeak(m.id, m.content)}
              className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded cursor-pointer ${
                isSpeaking
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/5'
              }`}
            >
              {isSpeaking ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              <span>{isSpeaking ? t(language, 'stopSpeaking') : t(language, 'readAloud')}</span>
            </button>
          )}

          {m.role === 'user' && !streaming && (
            <button
              type="button"
              onClick={() => onStartEdit(m.id, m.content)}
              className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
            >
              <Pencil className="w-3.5 h-3.5" />
              <span>{t(language, 'edit')}</span>
            </button>
          )}

          {isLastAssistant && (
            <>
              <button
                type="button"
                onClick={onRegenerate}
                className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 px-2 py-1 rounded hover:bg-emerald-500/10 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t(language, 'regenerate')}</span>
              </button>
              <button
                type="button"
                onClick={onContinue}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-300 px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
              >
                <span>{t(language, 'continueResponse')}</span>
              </button>
            </>
          )}
        </div>
      </article>
    );
  }
);

interface ChatWorkspaceProps {
  user: PublicUser | null;
  language: AppLanguage;
  models: BrandedModel[];
  projects: Project[];
  conversations: Conversation[];
  activeConvId: string | null;
  activeModelId: string;
  activeProjectId: string | null;
  queuedDocAttachment?: DocumentAttachment | null;
  onConsumeQueuedDocAttachment?: () => void;
  onSelectConvId: (id: string | null) => void;
  onSelectModel: (id: string) => void;
  onSelectProject: (id: string | null) => void;
  onOpenModelHub: () => void;
  onOpenIntegrations?: () => void;
  onOpenUsage?: () => void;
  onOpenAuth: () => void;
  onRefreshConversations: () => Promise<void>;
  onUsageUpdate: (usage: { dailyUsed: number; monthlyUsed: number }) => void;
}

const TEXT_DOC_EXT = /\.(txt|md|markdown|json|csv|tsv|ts|tsx|js|jsx|py|sql|html|css|yml|yaml|log)$/i;
const BINARY_DOC_EXT = /\.(pdf|docx|xlsx|xls)$/i;

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({
  user,
  language,
  models,
  projects,
  conversations,
  activeConvId,
  activeModelId,
  activeProjectId,
  queuedDocAttachment,
  onConsumeQueuedDocAttachment,
  onSelectConvId,
  onSelectModel,
  onSelectProject,
  onOpenModelHub,
  onOpenIntegrations,
  onOpenUsage,
  onOpenAuth,
  onRefreshConversations,
  onUsageUpdate,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [docAttachments, setDocAttachments] = useState<DocumentAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamActivity, setStreamActivity] = useState<ChatActivityStage | null>(null);
  const [streamActivityDetail, setStreamActivityDetail] = useState<string | null>(null);
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestratorMode>('auto');
  const [resolvedMode, setResolvedMode] = useState<Exclude<OrchestratorMode, 'auto'> | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [lastFailedRetry, setLastFailedRetry] = useState<{
    promptText: string;
    mode: 'send' | 'regenerate' | 'edit_resend' | 'continue';
    convId?: string;
    targetMessageId?: string;
  } | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedMsgs, setExpandedMsgs] = useState<Record<string, boolean>>({});
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  // Top bar & Context panel controls
  const [showThreadSearch, setShowThreadSearch] = useState(false);
  const [threadQuery, setThreadQuery] = useState('');
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // Unified Composer + Menu, Connectors, Built-in Tools & Camera Capture
  const [builtinTools, setBuiltinTools] = useState<BuiltinTool[]>([]);
  const [enabledToolIds, setEnabledToolIds] = useState<string[]>([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusToolsExpanded, setPlusToolsExpanded] = useState(false);
  const [integrationsCount, setIntegrationsCount] = useState<number | null>(null);
  const [projectFiles, setProjectFiles] = useState<ProjectFileRecord[]>([]);

  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraFallbackInputRef = useRef<HTMLInputElement | null>(null);
  const plusMenuContainerRef = useRef<HTMLDivElement | null>(null);

  // Voice Speech-to-Text & Text-to-Speech
  const [listening, setListening] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [openCitationMsgId, setOpenCitationMsgId] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const activeConvIdRef = useRef<string | null>(activeConvId);
  activeConvIdRef.current = activeConvId;
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
  const streamRunCounterRef = useRef(0);
  const activeStreamRef = useRef<{ runId: number; convId: string | null } | null>(null);
  const messagesFetchSeqRef = useRef(0);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const docInputRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const activeModel = models.find((m) => m.id === activeModelId) ?? models[0];
  const activeConversation = conversations.find((c) => c.id === activeConvId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const stopCameraStream = useCallback(() => {
    if (cameraStreamRef.current) {
      for (const track of cameraStreamRef.current.getTracks()) {
        track.stop();
      }
      cameraStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setBuiltinTools([]);
      setIntegrationsCount(null);
      return;
    }
    api.getBuiltinTools().then((res) => setBuiltinTools(res.tools.filter((x) => x.enabled))).catch(() => null);
    api
      .getIntegrations()
      .then((res) => setIntegrationsCount(res.connectors.filter((c) => c.status === 'connected').length))
      .catch(() => setIntegrationsCount(null));
  }, [user?.id]);

  useEffect(() => {
    if (!plusMenuOpen) return;
    const handlePointerDown = (ev: MouseEvent) => {
      if (plusMenuContainerRef.current && !plusMenuContainerRef.current.contains(ev.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [plusMenuOpen]);

  useEffect(() => {
    if (!user || !activeProjectId) {
      setProjectFiles([]);
      return;
    }
    api.getProjectFiles(activeProjectId).then((res) => setProjectFiles(res.files)).catch(() => setProjectFiles([]));
  }, [user?.id, activeProjectId]);

  useEffect(() => {
    if (!queuedDocAttachment) return;
    setDocAttachments((prev) => [...prev.filter((d) => d.name !== queuedDocAttachment.name).slice(0, 3), queuedDocAttachment]);
    onConsumeQueuedDocAttachment?.();
  }, [queuedDocAttachment]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      activeStreamRef.current = null;
      stopCameraStream();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [stopCameraStream]);

  useEffect(() => {
    if (activeConversation?.shareId) {
      setShareUrl(`${window.location.origin}/?share=${activeConversation.shareId}`);
    } else {
      setShareUrl(null);
    }

    // Do not race a history fetch when onMeta updates activeConvId for the active stream
    if (activeStreamRef.current && activeStreamRef.current.convId === activeConvId && activeConvId) {
      return;
    }

    // Switching away while another stream was active cancels the previous stream cleanly
    if (activeStreamRef.current && activeStreamRef.current.convId !== activeConvId) {
      activeStreamRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      setStreaming(false);
      setStreamingText('');
    }

    const fetchSeq = ++messagesFetchSeqRef.current;

    if (!activeConvId || !user) {
      setMessages([]);
      setShareUrl(null);
      setError(null);
      setLastFailedRetry(null);
      return;
    }

    const targetConvId = activeConvId;
    setError(null);
    setLastFailedRetry(null);
    setMessages([]);

    api
      .getMessages(targetConvId)
      .then((res) => {
        if (fetchSeq !== messagesFetchSeqRef.current || activeConvIdRef.current !== targetConvId) {
          return;
        }
        setMessages(res.messages);
      })
      .catch((err) => {
        if (fetchSeq !== messagesFetchSeqRef.current || activeConvIdRef.current !== targetConvId) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Unable to load conversation messages.');
      });
  }, [activeConvId, user?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' });
  }, [messages.length, streaming, streamingText]);

  const filteredMessages = useMemo(() => {
    const q = threadQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, threadQuery]);

  const processIncomingFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    for (const file of files) {
      if (file.size === 0) {
        setError(`File "${file.name}" is empty (0 bytes).`);
        continue;
      }
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
        if (file.size > 4_000_000) {
          setError(`Image "${file.name}" exceeds 4 MB.`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = String(reader.result ?? '').split(',')[1] ?? '';
          if (!base64) {
            setError(`Image "${file.name}" could not be read.`);
            return;
          }
          setAttachments((prev) => [
            ...prev.slice(0, 2),
            { mimeType: file.type, dataBase64: base64, name: file.name, sizeBytes: file.size },
          ]);
        };
        reader.onerror = () => {
          setError(`Failed to read image "${file.name}".`);
        };
        reader.readAsDataURL(file);
      } else if (
        file.type.startsWith('text/') ||
        file.type === 'application/json' ||
        TEXT_DOC_EXT.test(file.name)
      ) {
        if (file.size > 1_500_000) {
          setError(`Document "${file.name}" exceeds 1.5 MB.`);
          continue;
        }
        const text = (await file.text()).slice(0, 48_000);
        setDocAttachments((prev) => [
          ...prev.slice(0, 3),
          {
            name: file.name,
            mimeType: file.type || 'text/plain',
            sizeBytes: file.size,
            extractedText: text,
          },
        ]);
      } else if (BINARY_DOC_EXT.test(file.name)) {
        if (!user) {
          onOpenAuth();
          return;
        }
        if (file.size > 5_000_000) {
          setError(`Document "${file.name}" exceeds 5 MB.`);
          continue;
        }
        try {
          const dataBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
            reader.onerror = () => reject(new Error('Failed to read file.'));
            reader.readAsDataURL(file);
          });
          const uploaded = await api.uploadFile({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
            dataBase64,
            folder: 'Chat Attachments',
          });
          setDocAttachments((prev) => [
            ...prev.slice(0, 3),
            {
              name: uploaded.file.name,
              mimeType: uploaded.file.mimeType,
              sizeBytes: uploaded.file.sizeBytes,
              extractedText: uploaded.file.extractedText.slice(0, 48_000),
            },
          ]);
        } catch (err) {
          setError(err instanceof Error ? err.message : `Failed to parse "${file.name}".`);
        }
      } else {
        setError(`Unsupported file "${file.name}". Supported: PNG/JPEG/WEBP/GIF images or PDF/DOCX/XLSX/TXT/MD/JSON/CSV/Code documents.`);
      }
    }
  };

  const runStream = async (params: {
    promptText: string;
    mode?: 'send' | 'regenerate' | 'edit_resend' | 'continue';
    targetMessageId?: string;
    convId?: string;
  }) => {
    if (!user) {
      onOpenAuth();
      return;
    }
    if (!activeModel) return;

    const runId = ++streamRunCounterRef.current;
    let resolvedConvId = params.convId ?? activeConvId ?? undefined;
    activeStreamRef.current = { runId, convId: resolvedConvId ?? null };
    const isCurrentRun = () => activeStreamRef.current?.runId === runId;

    setError(null);
    setErrorCode(null);
    setErrorStatus(null);
    setFallbackNotice(null);
    setLastFailedRetry(null);
    setPlusMenuOpen(false);
    setStreamActivity(null);
    setStreamActivityDetail(null);
    setStreaming(true);
    setStreamingText('');

    const controller = new AbortController();
    abortRef.current = controller;

    const hasAttachmentsPayload = attachments.length > 0 || docAttachments.length > 0;
    const displayUserPrompt =
      params.promptText || (hasAttachmentsPayload ? 'Please analyze the attached file(s) and image(s).' : '');

    if (params.mode !== 'regenerate' && params.mode !== 'continue') {
      const tempUserMsg: ChatMessage = {
        id: `temp-${Date.now()}-${runId}`,
        conversationId: resolvedConvId ?? 'pending',
        role: 'user',
        content: displayUserPrompt,
        attachments: [
          ...attachments.map((a) => ({ mimeType: a.mimeType, name: a.name, kind: 'image' as const })),
          ...docAttachments.map((d) => ({ mimeType: d.mimeType, name: d.name, kind: 'document' as const })),
        ],
        createdAt: new Date().toISOString(),
      };
      if (params.mode === 'edit_resend' && params.targetMessageId) {
        const idx = messagesRef.current.findIndex((m) => m.id === params.targetMessageId);
        if (idx >= 0) {
          setMessages([...messagesRef.current.slice(0, idx), tempUserMsg]);
        } else {
          setMessages((prev) => [...prev, tempUserMsg]);
        }
      } else {
        setMessages((prev) => [...prev, tempUserMsg]);
      }
    } else if (params.mode === 'regenerate') {
      const prevMsgs = messagesRef.current;
      const last = prevMsgs[prevMsgs.length - 1];
      if (last?.role === 'assistant') {
        setMessages(prevMsgs.slice(0, -1));
      }
    }

    let userMessageIdFromServer: string | undefined;
    let serverAssistantMessageId: string | undefined;
    let streamedText = '';
    let terminalWork: Promise<void> | null = null;

    const reconcileAfterStream = async (opts?: { overrideConvId?: string; overrideAssistantId?: string }) => {
      const cid = opts?.overrideConvId ?? resolvedConvId;
      let dbMsgs: ChatMessage[] | null = null;
      if (cid) {
        const fetchSeq = ++messagesFetchSeqRef.current;
        try {
          const refreshed = await api.getMessages(cid);
          if (isCurrentRun() && fetchSeq === messagesFetchSeqRef.current) {
            dbMsgs = refreshed.messages;
          }
        } catch {
          dbMsgs = null;
        }
      }
      if (!isCurrentRun()) return;

      const merged = reconcileStreamMessages({
        dbMessages: dbMsgs,
        fallbackMessages: messagesRef.current,
        streamedText,
        conversationId: cid ?? 'pending',
        modelId: activeModel.id,
        localPartialId: `partial-${runId}`,
        userMessageIdFromServer,
        serverAssistantMessageId: opts?.overrideAssistantId ?? serverAssistantMessageId,
      });
      setMessages(merged);
    };

    try {
      await streamChat({
        conversationId: resolvedConvId,
        projectId: activeProjectId,
        modelId: activeModel.id,
        prompt: params.promptText,
        mode: params.mode ?? 'send',
        orchestrationMode,
        targetMessageId: params.targetMessageId,
        allowFallback: user.allowFallback,
        enabledToolIds,
        documentAttachments: docAttachments.length > 0 ? docAttachments : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        signal: controller.signal,
        onMeta: (meta) => {
          resolvedConvId = meta.conversationId;
          if (meta.userMessageId) {
            userMessageIdFromServer = meta.userMessageId;
          }
          if (!isCurrentRun()) return;
          activeStreamRef.current = { runId, convId: meta.conversationId };
          onSelectConvId(meta.conversationId);
          if (meta.resolvedMode) {
            setResolvedMode(meta.resolvedMode);
          }
          if (meta.fallbackNotice) {
            setFallbackNotice(String(meta.fallbackNotice));
          } else if (meta.fallbackFromModelId && meta.modelId && meta.fallbackFromModelId !== meta.modelId) {
            const origName = models.find((x) => x.id === meta.fallbackFromModelId)?.displayName ?? meta.fallbackFromModelId;
            const nextName = models.find((x) => x.id === meta.modelId)?.displayName ?? meta.modelId;
            const detail = meta.fallbackReason
              ? ` (${meta.fallbackErrorClass ? `${meta.fallbackErrorClass}: ` : ''}${meta.fallbackReason})`
              : '';
            setFallbackNotice(`${origName} switched to ${nextName}${detail}`);
          }
        },
        onStatus: (status) => {
          if (!isCurrentRun()) return;
          setStreamActivity(status.stage);
          setStreamActivityDetail(status.detail ?? null);
        },
        onChunk: (chunk) => {
          streamedText += chunk;
          if (isCurrentRun()) {
            setStreamActivity('generating');
            setStreamingText(streamedText);
          }
        },
        onDone: (done) => {
          terminalWork = (async () => {
            if (done.messageId) {
              serverAssistantMessageId = done.messageId;
            }
            if (done.quota) onUsageUpdate(done.quota);
            const cid = done.conversationId || resolvedConvId;
            if (cid && isCurrentRun()) {
              activeStreamRef.current = { runId, convId: cid };
              onSelectConvId(cid);
            }
            await reconcileAfterStream({ overrideConvId: cid, overrideAssistantId: done.messageId });
            if (isCurrentRun()) {
              setAttachments([]);
              setDocAttachments([]);
              if (done.aborted && !streamedText.trim() && !done.messageId) {
                setError('Generation was stopped before any output was produced.');
              }
            }
            void onRefreshConversations();
          })();
        },
        onError: (errMsg, errMeta) => {
          terminalWork = (async () => {
            if (errMeta?.messageId) {
              serverAssistantMessageId = errMeta.messageId;
            }
            const cid = errMeta?.conversationId || resolvedConvId;
            if (cid && isCurrentRun()) {
              activeStreamRef.current = { runId, convId: cid };
              onSelectConvId(cid);
            }
            await reconcileAfterStream({ overrideConvId: cid, overrideAssistantId: errMeta?.messageId });
            if (isCurrentRun()) {
              if (userMessageIdFromServer) {
                setAttachments([]);
                setDocAttachments([]);
              }
              setError(errMsg);
              const metaRecord = errMeta as unknown as { code?: string; status?: number } | undefined;
              const code = typeof metaRecord?.code === 'string' ? metaRecord.code : null;
              setErrorCode(code);
              setErrorStatus(typeof metaRecord?.status === 'number' ? metaRecord.status : null);
              if (code !== 'ENTITLEMENT_REQUIRED') {
                setLastFailedRetry({
                  promptText: params.promptText,
                  mode: userMessageIdFromServer ? 'regenerate' : (params.mode ?? 'send'),
                  convId: cid,
                  targetMessageId: params.targetMessageId,
                });
              } else {
                setLastFailedRetry(null);
              }
            }
            if (cid) {
              void onRefreshConversations();
            }
          })();
        },
      });
      if (terminalWork) {
        await terminalWork;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (isCurrentRun()) {
          await reconcileAfterStream();
          if (userMessageIdFromServer) {
            setAttachments([]);
            setDocAttachments([]);
          }
          if (!streamedText.trim()) {
            setError('Generation stopped before receiving a response.');
          }
          if (resolvedConvId) {
            void onRefreshConversations();
          }
        }
      } else if (isCurrentRun()) {
        await reconcileAfterStream();
        if (userMessageIdFromServer) {
          setAttachments([]);
          setDocAttachments([]);
        }
        setError(err instanceof Error ? err.message : 'Streaming interrupted.');
        if (err instanceof ApiError) {
          setErrorStatus(err.status);
          setErrorCode(err.code ?? null);
          if (err.status === 403 || err.code === 'ENTITLEMENT_REQUIRED') {
            setLastFailedRetry(null);
          } else {
            setLastFailedRetry({
              promptText: params.promptText,
              mode: userMessageIdFromServer ? 'regenerate' : (params.mode ?? 'send'),
              convId: resolvedConvId,
              targetMessageId: params.targetMessageId,
            });
          }
        } else {
          setLastFailedRetry({
            promptText: params.promptText,
            mode: userMessageIdFromServer ? 'regenerate' : (params.mode ?? 'send'),
            convId: resolvedConvId,
            targetMessageId: params.targetMessageId,
          });
        }
      }
    } finally {
      if (isCurrentRun()) {
        setStreaming(false);
        setStreamingText('');
        setStreamActivity(null);
        setStreamActivityDetail(null);
        abortRef.current = null;
        activeStreamRef.current = null;
      }
    }
  };

  const hasComposerPayload = Boolean(input.trim() || attachments.length > 0 || docAttachments.length > 0);

  const handleSend = () => {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0 && docAttachments.length === 0) || streaming) return;
    setInput('');
    runStream({ promptText: trimmed, mode: 'send' });
  };

  const handleVoiceToggle = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const SpeechRec =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionInstance }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionInstance }).webkitSpeechRecognition;

    if (!SpeechRec) {
      setError('Voice input requires a browser supporting Web Speech Recognition (e.g., Chrome or Edge).');
      return;
    }
    try {
      const rec = new SpeechRec();
      rec.lang = language === 'ar' ? 'ar-SA' : 'en-US';
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (ev) => {
        const transcript = ev.results?.[0]?.[0]?.transcript ?? '';
        if (transcript) {
          setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
        }
      };
      rec.onerror = (ev) => {
        setError(`Voice input error: ${ev.error}`);
        setListening(false);
      };
      rec.onend = () => {
        setListening(false);
      };
      recognitionRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      setError('Unable to access microphone for voice input.');
      setListening(false);
    }
  };

  const handleCopy = useCallback((id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => null);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
  }, []);

  const handleToggleSpeak = useCallback(
    (msgId: string, text: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setError('Voice output (Text-to-Speech) is not supported in this browser.');
        return;
      }
      const synth = window.speechSynthesis;
      if (speakingMsgId === msgId) {
        synth.cancel();
        setSpeakingMsgId(null);
        return;
      }
      synth.cancel();
      const cleanText = text.replace(/```[\s\S]*?```/g, ' Code block. ').replace(/[#*`>_~]/g, ' ').trim();
      const utter = new SpeechSynthesisUtterance(cleanText.slice(0, 3000));
      utter.lang = language === 'ar' ? 'ar-SA' : 'en-US';
      utter.onend = () => setSpeakingMsgId((prev) => (prev === msgId ? null : prev));
      utter.onerror = () => setSpeakingMsgId((prev) => (prev === msgId ? null : prev));
      setSpeakingMsgId(msgId);
      synth.speak(utter);
    },
    [language, speakingMsgId]
  );

  const handleExport = (format: 'md' | 'json') => {
    if (!messages.length) return;
    const title = activeConversation?.title ?? 'LOODY Conversation';
    const safeSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'conversation';
    if (format === 'md') {
      const md = buildConversationMarkdown({ title, modelId: activeModel?.displayName ?? activeModelId, messages });
      triggerBrowserDownload(`${safeSlug}.md`, md, 'text/markdown;charset=utf-8');
    } else {
      const json = buildConversationJson({ title, modelId: activeModel?.displayName ?? activeModelId, messages });
      triggerBrowserDownload(`${safeSlug}.json`, json, 'application/json;charset=utf-8');
    }
  };

  const handleCreateShare = async () => {
    if (!activeConvId) return;
    try {
      const res = await api.shareConversation(activeConvId);
      setShareUrl(res.shareUrl);
      navigator.clipboard.writeText(res.shareUrl).catch(() => null);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to share conversation.');
    }
  };

  const handleRevokeShare = async () => {
    if (!activeConvId) return;
    await api.unshareConversation(activeConvId);
    setShareUrl(null);
    await onRefreshConversations();
  };

  const markdownComponents = useMemo<Components>(
    () => ({
      pre({ children }: { children?: React.ReactNode }) {
        return <CodeBlock>{children}</CodeBlock>;
      },
      a({ href, children }: { href?: string; children?: React.ReactNode }) {
        const safeHref = toSafeHref(href);
        if (!safeHref) {
          return <span className="underline decoration-dotted text-zinc-500">{children}</span>;
        }
        return (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-600 dark:text-emerald-400 underline underline-offset-2 hover:text-emerald-500"
          >
            {children}
          </a>
        );
      },
      img({ src, alt }: { src?: string; alt?: string }) {
        const safeSrc = typeof src === 'string' ? toSafeMarkdownUrl(src, 'src') : '';
        if (!safeSrc) return null;
        return (
          <img
            src={safeSrc}
            alt={alt ?? 'Attachment'}
            loading="lazy"
            className="my-2 max-h-80 rounded-xl border border-zinc-200 dark:border-white/10 object-contain"
          />
        );
      },
    }),
    []
  );

  const openCameraModal = useCallback(async () => {
    setPlusMenuOpen(false);
    setCameraModalOpen(true);
    setCapturedDataUrl(null);
    setCameraError(null);
    setCameraLoading(true);
    stopCameraStream();

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCameraLoading(false);
      setCameraError(t(language, 'cameraDenied'));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => null);
      }
      setCameraLoading(false);
    } catch {
      stopCameraStream();
      setCameraLoading(false);
      setCameraError(t(language, 'cameraDenied'));
    }
  }, [language, stopCameraStream]);

  const closeCameraModal = useCallback(() => {
    stopCameraStream();
    setCameraModalOpen(false);
    setCapturedDataUrl(null);
    setCameraError(null);
    setCameraLoading(false);
  }, [stopCameraStream]);

  const captureCameraFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/png');
    setCapturedDataUrl(dataUrl);
    stopCameraStream();
  }, [stopCameraStream]);

  const confirmCameraPhoto = useCallback(async () => {
    if (!capturedDataUrl) return;
    try {
      const resp = await fetch(capturedDataUrl);
      const blob = await resp.blob();
      const file = new File([blob], `camera-capture-${Date.now()}.png`, { type: 'image/png' });
      await processIncomingFiles([file]);
      closeCameraModal();
    } catch {
      setCameraError('Could not attach captured photo.');
    }
  }, [capturedDataUrl, closeCameraModal]);

  const handleToggleExpandMsg = useCallback((id: string, nextExpanded: boolean) => {
    setExpandedMsgs((prev) => ({ ...prev, [id]: nextExpanded }));
  }, []);

  const handleToggleCitationMsg = useCallback((id: string) => {
    setOpenCitationMsgId((prev) => (prev === id ? null : id));
  }, []);

  const handleStartEditMsg = useCallback((id: string, content: string) => {
    setEditingMsgId(id);
    setEditingText(content);
  }, []);

  const handleCancelEditMsg = useCallback(() => {
    setEditingMsgId(null);
  }, []);

  const handleSaveEditMsg = useCallback(
    (id: string) => {
      const next = editingText.trim();
      setEditingMsgId(null);
      if (next && activeConvIdRef.current) {
        runStream({
          promptText: next,
          mode: 'edit_resend',
          targetMessageId: id,
          convId: activeConvIdRef.current,
        });
      }
    },
    [editingText]
  );

  const handleRegenerateLast = useCallback(() => {
    const lastUser = [...messagesRef.current].reverse().find((x) => x.role === 'user');
    if (lastUser && activeConvIdRef.current) {
      runStream({ promptText: lastUser.content, mode: 'regenerate', convId: activeConvIdRef.current });
    }
  }, []);

  const handleContinueLast = useCallback(() => {
    if (activeConvIdRef.current) {
      runStream({
        promptText: 'Continue',
        mode: 'continue',
        convId: activeConvIdRef.current,
      });
    }
  }, []);

  const modelNameById = useMemo(() => new Map(models.map((x) => [x.id, x.displayName])), [models]);

  return (
    <div
      className="relative flex h-full w-full overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        if (e.dataTransfer.files?.length) {
          processIncomingFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Main Chat Column */}
      <div className="flex flex-1 flex-col h-full min-w-0 bg-[#F8FAF9] dark:bg-[#050706]">
        {/* Chat Sub-Toolbar */}
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 dark:border-white/8 bg-white/95 dark:bg-[#080B09]/95 px-3 sm:px-5 py-2">
          <div className="flex flex-1 items-center gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate text-xs sm:text-sm font-semibold text-zinc-900 dark:text-white">
                {activeConversation?.title ?? t(language, 'newChat')}
              </span>
              {activeProject && (
                <span className="hidden md:inline-flex items-center rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 truncate max-w-[160px]">
                  {activeProject.name}
                </span>
              )}
              {resolvedMode && (
                <span className="hidden xl:inline-flex items-center rounded-md border border-zinc-200 dark:border-white/10 bg-zinc-100 dark:bg-white/5 px-2 py-0.5 text-[10px] font-mono uppercase text-zinc-600 dark:text-zinc-300">
                  {resolvedMode.replace('_', ' ')}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {messages.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowThreadSearch((v) => !v)}
                  aria-label="Search inside conversation"
                  title="Search in thread"
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border text-xs cursor-pointer ${
                    showThreadSearch
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'border-zinc-200 dark:border-white/10 text-zinc-500 hover:text-zinc-900 dark:hover:text-white'
                  }`}
                >
                  <Search className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleExport('md')}
                  aria-label="Export conversation as Markdown"
                  title="Export Markdown"
                  className="hidden sm:flex h-9 px-2.5 items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500/40 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>MD</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExport('json')}
                  aria-label="Export conversation as JSON"
                  title="Export JSON"
                  className="hidden sm:flex h-9 px-2.5 items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500/40 cursor-pointer"
                >
                  <span>JSON</span>
                </button>
                {activeConvId && (
                  <button
                    type="button"
                    onClick={handleCreateShare}
                    aria-label={t(language, 'shareChat')}
                    title="Create read-only share link"
                    className="flex h-9 px-2.5 items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500/40 cursor-pointer"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span className="hidden md:inline">{shareCopied ? 'Copied' : t(language, 'shareChat')}</span>
                  </button>
                )}
              </>
            )}

            {user && conversations.length > 0 && (
              <button
                type="button"
                onClick={() => setClearConfirmOpen(true)}
                aria-label="Clear chat history"
                title={t(language, 'clearHistory')}
                className="hidden sm:flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 text-zinc-500 hover:text-red-500 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={() => setContextPanelOpen((v) => !v)}
              aria-label="Toggle right context panel"
              title="Context Inspector"
              className={`flex h-9 w-9 items-center justify-center rounded-lg border cursor-pointer ${
                contextPanelOpen
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-zinc-200 dark:border-white/10 text-zinc-500 hover:text-zinc-900 dark:hover:text-white'
              }`}
            >
              <PanelRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Optional In-Conversation Search Bar */}
        {showThreadSearch && (
          <div className="border-b border-zinc-200 dark:border-white/8 bg-white dark:bg-[#0A0E0C] px-4 py-2 flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-zinc-400" />
            <input
              type="search"
              autoFocus
              aria-label="Filter messages in active conversation"
              value={threadQuery}
              onChange={(e) => setThreadQuery(e.target.value)}
              placeholder="Search messages in this conversation..."
              className="flex-1 bg-transparent text-xs text-zinc-900 dark:text-white focus:outline-none"
            />
            {threadQuery && (
              <span className="text-[11px] text-zinc-400 tabular-nums">
                {filteredMessages.length} match(es)
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setThreadQuery('');
                setShowThreadSearch(false);
              }}
              aria-label="Close thread search"
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Active Share Banner */}
        {shareUrl && (
          <div className="border-b border-emerald-500/20 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <Share2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="text-emerald-900 dark:text-emerald-200 truncate">
                Shared read-only link: <a href={shareUrl} className="underline font-mono">{shareUrl}</a>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(shareUrl);
                  setShareCopied(true);
                  window.setTimeout(() => setShareCopied(false), 1500);
                }}
                className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white cursor-pointer"
              >
                {shareCopied ? 'Copied URL' : 'Copy URL'}
              </button>
              <button
                type="button"
                onClick={handleRevokeShare}
                className="rounded-lg border border-red-500/30 px-2.5 py-1 text-[11px] font-medium text-red-600 dark:text-red-300 cursor-pointer"
              >
                Revoke
              </button>
            </div>
          </div>
        )}

        {/* Fallback Info Notice */}
        {fallbackNotice && (
          <div className="border-b border-amber-500/20 bg-amber-50 dark:bg-amber-950/20 px-4 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-2">
            <span>{fallbackNotice}</span>
            <button type="button" onClick={() => setFallbackNotice(null)} aria-label="Dismiss routing notice" className="cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Drag-and-drop overlay */}
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-emerald-950/60 backdrop-blur-xs border-2 border-dashed border-emerald-400">
            <div className="rounded-2xl bg-white dark:bg-[#0D110F] px-6 py-4 text-sm font-semibold text-emerald-700 dark:text-emerald-300 shadow-xl">
              Drop images or text documents to attach to LOODY
            </div>
          </div>
        )}

        {/* Message Stream or Empty Home Screen */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
          {messages.length === 0 && !streaming ? (
            <div className="mx-auto flex max-w-2xl flex-col items-center text-center pt-4 sm:pt-12 pb-8">
              <LoodyLogo variant="primary-3d" size={56} />
              <h1 className="mt-5 font-display text-2xl sm:text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">
                {t(language, 'welcomeTitle')}
              </h1>
              <p className="mt-2.5 max-w-lg text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                {t(language, 'welcomeSubtitle')}
              </p>

              {/* Quick Suggestions */}
              <div className="mt-8 grid w-full gap-3 sm:grid-cols-3 text-start">
                {[
                  t(language, 'quickPrompt1'),
                  t(language, 'quickPrompt2'),
                  t(language, 'quickPrompt3'),
                ].map((promptText, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      if (!user) onOpenAuth();
                      else runStream({ promptText, mode: 'send' });
                    }}
                    className="rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 text-xs text-zinc-700 dark:text-zinc-200 hover:border-emerald-500/50 transition-colors min-h-[84px] flex flex-col justify-between cursor-pointer"
                  >
                    <span className="leading-relaxed">{promptText}</span>
                    <span className="mt-3 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                      {activeModel?.displayName ?? 'Sonic 3'} →
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {filteredMessages.map((m, idx) => {
                const isLastAssistant =
                  m.role === 'assistant' && idx === filteredMessages.length - 1 && !streaming;
                const authorLabel =
                  m.role === 'user'
                    ? user?.displayName ?? 'You'
                    : (m.modelId ? modelNameById.get(m.modelId) : undefined) ?? 'LOODY';

                return (
                  <MemoMessageBubble
                    key={m.id}
                    message={m}
                    language={language}
                    authorLabel={authorLabel}
                    isLastAssistant={isLastAssistant}
                    isCopied={copiedId === m.id}
                    isSpeaking={speakingMsgId === m.id}
                    isExpanded={expandedMsgs[m.id] ?? true}
                    isEditing={editingMsgId === m.id}
                    editingText={editingMsgId === m.id ? editingText : ''}
                    isCitationOpen={openCitationMsgId === m.id}
                    streaming={streaming}
                    markdownComponents={markdownComponents}
                    onCopy={handleCopy}
                    onToggleSpeak={handleToggleSpeak}
                    onToggleExpand={handleToggleExpandMsg}
                    onToggleCitation={handleToggleCitationMsg}
                    onStartEdit={handleStartEditMsg}
                    onChangeEditingText={setEditingText}
                    onSaveEdit={handleSaveEditMsg}
                    onCancelEdit={handleCancelEditMsg}
                    onRegenerate={handleRegenerateLast}
                    onContinue={handleContinueLast}
                  />
                );
              })}

              {streaming && (
                <article
                  aria-live="polite"
                  className="rounded-2xl bg-white dark:bg-[#0A0E0C] border border-emerald-500/35 p-4 sm:p-5 shadow-xs"
                >
                  <div className="mb-2.5 flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 font-semibold text-emerald-600 dark:text-emerald-400">
                      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                      <span>{activeModel?.displayName ?? 'LOODY'}</span>
                      <span
                        data-testid="chat-activity-status"
                        className="font-normal text-zinc-500 dark:text-zinc-400"
                      >
                        ·{' '}
                        {streamActivity === 'analyzing_files'
                          ? t(language, 'activityAnalyzingFiles')
                          : streamActivity === 'searching'
                          ? t(language, 'activitySearching')
                          : streamActivity === 'using_tools'
                          ? t(language, 'activityUsingTools')
                          : streamActivity === 'reading_sources'
                          ? t(language, 'activityReadingSources')
                          : streamActivity === 'thinking'
                          ? t(language, 'activityThinking')
                          : t(language, 'activityGenerating')}
                        {streamActivityDetail && streamActivity === 'using_tools' ? ` (${streamActivityDetail})` : ''}
                      </span>
                    </div>
                    {resolvedMode && (
                      <span className="font-mono text-[10px] uppercase text-zinc-500 dark:text-zinc-400">
                        {resolvedMode.replace('_', ' ')}
                      </span>
                    )}
                  </div>
                  {streamingText ? (
                    <div className="prose prose-zinc dark:prose-invert prose-sm max-w-none leading-relaxed">
                      <InlineMarkdownErrorBoundary fallbackText={streamingText} resetKey={streamingText}>
                        <ReactMarkdown
                          remarkPlugins={REMARK_PLUGINS}
                          rehypePlugins={REHYPE_PLUGINS}
                          urlTransform={toSafeMarkdownUrl}
                          components={markdownComponents}
                        >
                          {streamingText}
                        </ReactMarkdown>
                      </InlineMarkdownErrorBoundary>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 py-1 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span>
                        {streamActivity === 'thinking'
                          ? t(language, 'activityThinking')
                          : streamActivity === 'searching'
                          ? t(language, 'activitySearching')
                          : streamActivity === 'reading_sources'
                          ? t(language, 'activityReadingSources')
                          : streamActivity === 'analyzing_files'
                          ? t(language, 'activityAnalyzingFiles')
                          : streamActivity === 'using_tools'
                          ? t(language, 'activityUsingTools')
                          : t(language, 'activityGenerating')}
                      </span>
                    </div>
                  )}
                </article>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* Error Banner with Entitlement Recovery or Retry */}
        {error && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-xs text-red-700 dark:text-red-200"
            >
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <AlertCircle className="w-4 h-4 text-red-500 dark:text-red-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(errorStatus === 403 || errorCode === 'ENTITLEMENT_REQUIRED') && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectModel('sonic-3.5');
                        setError(null);
                        setErrorCode(null);
                        setErrorStatus(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 cursor-pointer"
                    >
                      Switch to Sonic 3.5
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectModel('sonic-3');
                        setError(null);
                        setErrorCode(null);
                        setErrorStatus(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-white/80 dark:bg-[#0D110F] px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 hover:border-emerald-500 cursor-pointer"
                    >
                      Switch to Sonic 3
                    </button>
                    <button
                      type="button"
                      onClick={() => (onOpenUsage ? onOpenUsage() : onOpenModelHub())}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-2.5 py-1 text-[11px] font-medium text-red-700 dark:text-red-200 hover:bg-red-500/10 cursor-pointer"
                    >
                      {onOpenUsage ? 'Plans & Usage' : 'Model Hub'}
                    </button>
                  </>
                )}
                {lastFailedRetry && !streaming && (
                  <button
                    type="button"
                    onClick={() => runStream(lastFailedRetry)}
                    className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-500 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>{t(language, 'retry')}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setErrorCode(null);
                    setErrorStatus(null);
                  }}
                  aria-label="Dismiss error"
                  className="text-red-500 hover:text-red-700 dark:text-red-300 dark:hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cohesive Rounded Composer */}
        <div className="border-t border-zinc-200/80 dark:border-white/8 bg-[#F8FAF9]/90 dark:bg-[#050706]/95 px-3 sm:px-6 py-3">
          <div className="mx-auto max-w-3xl">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                if (e.target.files?.length) processIncomingFiles(e.target.files);
                e.target.value = '';
              }}
              className="hidden"
            />
            <input
              ref={docInputRef}
              type="file"
              accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.sql,.yml,.yaml,.log"
              onChange={(e) => {
                if (e.target.files?.length) processIncomingFiles(e.target.files);
                e.target.value = '';
              }}
              className="hidden"
            />

            <div
              ref={plusMenuContainerRef}
              className="relative rounded-2xl border border-zinc-200 dark:border-emerald-500/25 bg-white dark:bg-[#0D110F] shadow-sm transition-colors focus-within:border-emerald-500/70 focus-within:ring-2 focus-within:ring-emerald-500/10"
            >
              {/* Attachments & Enabled Tools Strip */}
              {(attachments.length > 0 || docAttachments.length > 0 || enabledToolIds.length > 0) && (
                <div className="flex flex-wrap gap-2 px-3 pt-3 pb-1">
                  {attachments.map((att, idx) => (
                    <div
                      key={`img-${idx}`}
                      className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-50/70 dark:bg-[#050706] pe-2 ps-1.5 py-1 text-xs text-emerald-800 dark:text-emerald-200"
                    >
                      <img
                        src={`data:${att.mimeType};base64,${att.dataBase64}`}
                        alt={att.name}
                        className="h-6 w-6 rounded-md object-cover border border-emerald-500/20"
                      />
                      <span className="truncate max-w-[130px]">{att.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${att.name}`}
                        onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-zinc-500 hover:text-red-500 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {docAttachments.map((docItem, idx) => (
                    <div
                      key={`doc-${idx}`}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-50/70 dark:bg-[#050706] px-2.5 py-1 text-xs text-emerald-800 dark:text-emerald-200"
                    >
                      <FilePlus2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span className="truncate max-w-[140px]">{docItem.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${docItem.name}`}
                        onClick={() => setDocAttachments((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-zinc-500 hover:text-red-500 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {enabledToolIds.map((tid) => (
                    <div
                      key={`tool-${tid}`}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/15 bg-zinc-100 dark:bg-white/5 px-2.5 py-1 text-[11px] text-zinc-700 dark:text-zinc-200"
                    >
                      <Wrench className="w-3 h-3 text-emerald-500 shrink-0" />
                      <span>{tid}</span>
                      <button
                        type="button"
                        aria-label={`Disable tool ${tid}`}
                        onClick={() => setEnabledToolIds((prev) => prev.filter((x) => x !== tid))}
                        className="text-zinc-500 hover:text-red-500 cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Message Input Area */}
              <div className="px-3.5 pt-2.5 pb-1">
                <label htmlFor="chat-composer" className="sr-only">
                  Message LOODY
                </label>
                <textarea
                  id="chat-composer"
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={t(language, 'composerPlaceholder')}
                  className="w-full resize-none bg-transparent py-1.5 text-sm leading-6 text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none min-h-[42px] max-h-40"
                />
              </div>

              {/* Unified + Popover Menu (Attachments, Camera, Connectors, Tools) */}
              {plusMenuOpen && (
                <div
                  role="menu"
                  aria-label={t(language, 'plusMenu')}
                  className="absolute bottom-full mb-2 start-0 z-40 w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-zinc-200 dark:border-emerald-500/25 bg-white dark:bg-[#0D110F] p-2 shadow-xl space-y-1 text-xs"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      imageInputRef.current?.click();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
                  >
                    <ImagePlus className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="font-medium">{t(language, 'attachImage')}</span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      docInputRef.current?.click();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
                  >
                    <FilePlus2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="font-medium">{t(language, 'attachFile')}</span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    onClick={openCameraModal}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
                  >
                    <Camera className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="font-medium">{t(language, 'cameraCapture')}</span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPlusMenuOpen(false);
                      if (!user) {
                        onOpenAuth();
                      } else {
                        onOpenIntegrations?.();
                      }
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-start text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Plug className="w-4 h-4 text-emerald-500 shrink-0" />
                      <span className="font-medium truncate">{t(language, 'connectorsLabel')}</span>
                    </span>
                    {integrationsCount !== null && (
                      <span className="shrink-0 text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                        {integrationsCount} {t(language, 'connectorsConnected')}
                      </span>
                    )}
                  </button>

                  <div className="border-t border-zinc-100 dark:border-white/8 pt-1 mt-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (!user) {
                          setPlusMenuOpen(false);
                          onOpenAuth();
                          return;
                        }
                        setPlusToolsExpanded((v) => !v);
                      }}
                      aria-expanded={plusToolsExpanded}
                      className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-start text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
                    >
                      <span className="flex items-center gap-2.5">
                        <Wrench className="w-4 h-4 text-emerald-500 shrink-0" />
                        <span className="font-medium">{t(language, 'workspaceTools')}</span>
                      </span>
                      <span className="flex items-center gap-1 text-[10px] font-mono text-zinc-500">
                        {enabledToolIds.length > 0 && (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">
                            {enabledToolIds.length}
                          </span>
                        )}
                        <ChevronRight
                          className={`w-3.5 h-3.5 transition-transform ${plusToolsExpanded ? 'rotate-90' : ''}`}
                        />
                      </span>
                    </button>

                    {plusToolsExpanded && (
                      <div className="mt-1 max-h-40 overflow-y-auto px-2 pb-1 flex flex-wrap gap-1.5">
                        {builtinTools.length === 0 ? (
                          <span className="px-1 py-1 text-[11px] text-zinc-500">No workspace tools enabled.</span>
                        ) : (
                          builtinTools.map((tool) => {
                            const active = enabledToolIds.includes(tool.id);
                            return (
                              <button
                                key={tool.id}
                                type="button"
                                onClick={() =>
                                  setEnabledToolIds((prev) =>
                                    active ? prev.filter((x) => x !== tool.id) : [...prev, tool.id]
                                  )
                                }
                                className={`rounded-lg border px-2 py-1 text-[11px] font-medium cursor-pointer ${
                                  active
                                    ? 'border-emerald-500 bg-emerald-600 text-white'
                                    : 'border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] text-zinc-700 dark:text-zinc-300'
                                }`}
                              >
                                {tool.name}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Bottom Controls Row INSIDE the Cohesive Rounded Composer */}
              <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                  <button
                    id="composer-plus-btn"
                    type="button"
                    aria-label={t(language, 'plusMenu')}
                    aria-expanded={plusMenuOpen}
                    aria-haspopup="menu"
                    title={t(language, 'plusMenu')}
                    onClick={() => setPlusMenuOpen((v) => !v)}
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors cursor-pointer ${
                      plusMenuOpen || enabledToolIds.length > 0
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] text-zinc-600 dark:text-zinc-300 hover:border-emerald-500/40'
                    }`}
                  >
                    <Plus className={`w-4 h-4 transition-transform ${plusMenuOpen ? 'rotate-45' : ''}`} />
                  </button>

                  {/* Model Selector inside Composer */}
                  <div className="relative flex items-center min-w-0 max-w-[138px] sm:max-w-[215px]">
                    <label htmlFor="chat-model-select" className="sr-only">
                      Select model
                    </label>
                    <select
                      id="chat-model-select"
                      value={activeModelId}
                      onChange={(e) => {
                        onSelectModel(e.target.value);
                        setError(null);
                        setErrorCode(null);
                        setErrorStatus(null);
                      }}
                      className="w-full truncate appearance-none rounded-xl border border-emerald-500/25 bg-zinc-50 dark:bg-[#050706] ps-2.5 pe-6 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 focus:border-emerald-500 focus:outline-none min-h-[36px] cursor-pointer"
                    >
                      {models.map((m) => {
                        const access = user
                          ? canAccessModel({ role: user.role, plan: user.plan }, m)
                          : { allowed: m.requiredPlan === 'free' };
                        const lockSuffix = !access.allowed ? ` · ${m.requiredPlan.toUpperCase()} / Dev Locked` : '';
                        return (
                          <option key={m.id} value={m.id}>
                            {m.displayName} ({getModelStatusMeta(m).shortLabel}){lockSuffix}
                          </option>
                        );
                      })}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-400 absolute end-2 pointer-events-none" />
                  </div>

                  {/* Orchestration Mode Selector inside Composer */}
                  <div className="relative flex items-center min-w-0 max-w-[106px] sm:max-w-[165px]">
                    <label htmlFor="chat-orchestrator-mode" className="sr-only">
                      Orchestration Mode
                    </label>
                    <select
                      id="chat-orchestrator-mode"
                      aria-label="Orchestration Mode"
                      value={orchestrationMode}
                      onChange={(e) => setOrchestrationMode(e.target.value as OrchestratorMode)}
                      className={`w-full truncate appearance-none rounded-xl border ps-2.5 pe-6 py-1.5 text-xs font-medium focus:border-emerald-500 focus:outline-none min-h-[36px] cursor-pointer ${
                        orchestrationMode !== 'auto'
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] text-zinc-700 dark:text-zinc-200'
                      }`}
                    >
                      <option value="auto">Auto</option>
                      <option value="fast">Fast</option>
                      <option value="deep_thinking">Deep Thinking</option>
                      <option value="research">Research</option>
                      <option value="coding">Coding (Kore)</option>
                      <option value="creative">Creative</option>
                      <option value="analysis">Data Analysis</option>
                      <option value="work">Work Planner</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-400 absolute end-2 pointer-events-none" />
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={handleVoiceToggle}
                    aria-label={t(language, 'voiceInput')}
                    title={listening ? 'Stop voice capture' : t(language, 'voiceInput')}
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl cursor-pointer transition-colors ${
                      listening
                        ? 'bg-red-500/15 text-red-500'
                        : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-white/5 hover:text-emerald-600'
                    }`}
                  >
                    {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  </button>

                  {streaming ? (
                    <button
                      type="button"
                      onClick={() => abortRef.current?.abort()}
                      aria-label={t(language, 'stop')}
                      title={t(language, 'stop')}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-red-600 px-3 text-xs font-semibold text-white hover:bg-red-500 cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span className="hidden sm:inline">{t(language, 'stop')}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!hasComposerPayload}
                      aria-label={t(language, 'send')}
                      title={t(language, 'send')}
                      className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      <ArrowUp className="w-4 h-4 stroke-[2.25]" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Optional Toggleable Right Context Panel */}
      {contextPanelOpen && (
        <>
          <button
            type="button"
            aria-label="Close context panel"
            onClick={() => setContextPanelOpen(false)}
            className="fixed inset-0 z-30 bg-black/40 md:hidden cursor-pointer"
          />
          <aside className="fixed inset-y-0 end-0 z-40 flex w-[min(18rem,85vw)] md:static md:w-72 shrink-0 flex-col border-s border-zinc-200 dark:border-white/10 bg-white dark:bg-[#080B09] p-4 overflow-y-auto space-y-5 text-xs shadow-xl md:shadow-none">
          <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/10 pb-3">
            <h2 className="font-display text-sm font-bold text-zinc-900 dark:text-white">Workspace Context</h2>
            <button
              type="button"
              onClick={() => setContextPanelOpen(false)}
              aria-label="Close context panel"
              className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Active Model</div>
            <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#0D110F] p-3 space-y-1">
              <div className="font-semibold text-emerald-600 dark:text-emerald-400">{activeModel?.displayName}</div>
              <div className="text-zinc-500 text-[11px]">
                {activeModel?.speedClass} · {activeModel?.reasoningLevel} Reasoning
              </div>
              <div className="text-[11px] text-zinc-500">
                Intra-model resilience: {user?.allowFallback ? 'Enabled' : 'Disabled'}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="context-project-select" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 block">
              Linked Project
            </label>
            <select
              id="context-project-select"
              value={activeProjectId ?? ''}
              onChange={(e) => onSelectProject(e.target.value || null)}
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#0D110F] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[38px]"
            >
              <option value="">{t(language, 'projectNone')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {activeProject && (
              <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#0D110F] p-3 space-y-1.5">
                <div className="font-medium text-zinc-900 dark:text-white">{activeProject.name}</div>
                {activeProject.instructions && (
                  <p className="text-[11px] text-zinc-500 line-clamp-4">{activeProject.instructions}</p>
                )}
                {projectFiles.length > 0 && (
                  <div className="pt-1 border-t border-zinc-200 dark:border-white/10">
                    <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 mb-1">
                      Project Files ({projectFiles.length})
                    </div>
                    {projectFiles.map((pf) => (
                      <div key={pf.id} className="truncate text-[11px] text-zinc-500">
                        · {pf.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {activeConversation && (
            <div className="space-y-1.5">
              <label htmlFor="conv-folder-input" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 block">
                Conversation Folder
              </label>
              <div className="flex gap-1.5">
                <input
                  id="conv-folder-input"
                  type="text"
                  defaultValue={activeConversation.folder}
                  placeholder="e.g. Engineering"
                  onBlur={async (e) => {
                    const nextFolder = e.target.value.trim();
                    if (nextFolder !== activeConversation.folder) {
                      await api.updateConversation(activeConversation.id, { folder: nextFolder });
                      await onRefreshConversations();
                    }
                  }}
                  className="flex-1 rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#0D110F] px-2.5 py-1.5 text-xs text-zinc-900 dark:text-white"
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Active Tools ({enabledToolIds.length})
            </div>
            {enabledToolIds.length === 0 ? (
              <p className="text-[11px] text-zinc-500">No context tools enabled for next message.</p>
            ) : (
              <ul className="space-y-1">
                {enabledToolIds.map((id) => (
                  <li key={id} className="rounded-lg border border-zinc-200 dark:border-white/10 px-2.5 py-1.5 font-mono text-[11px]">
                    {id}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
        </>
      )}

      {/* Clear History Modal */}
      {clearConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-2xl border border-red-500/30 bg-white dark:bg-[#0D110F] p-5 space-y-4">
            <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Clear All Conversations?</h3>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              This permanently removes your conversation history from the LOODY workspace. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setClearConfirmOpen(false)}
                className="rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2 text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  await api.clearConversations(false);
                  onSelectConvId(null);
                  setMessages([]);
                  setClearConfirmOpen(false);
                  await onRefreshConversations();
                }}
                className="rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 cursor-pointer"
              >
                Clear All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Camera Capture Modal */}
      {cameraModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t(language, 'cameraTitle')}
        >
          <div className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-white dark:bg-[#0D110F] p-4 sm:p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/10 pb-3">
              <div className="flex items-center gap-2 font-display text-sm font-bold text-zinc-900 dark:text-white">
                <Camera className="w-4 h-4 text-emerald-500" />
                <span>{t(language, 'cameraTitle')}</span>
              </div>
              <button
                type="button"
                onClick={closeCameraModal}
                aria-label="Close camera modal"
                className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <canvas ref={canvasRef} className="hidden" />
            <input
              ref={cameraFallbackInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                if (e.target.files?.length) {
                  processIncomingFiles(e.target.files);
                  closeCameraModal();
                }
                e.target.value = '';
              }}
              className="hidden"
            />

            {cameraError ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-50 dark:bg-amber-950/30 p-4 text-xs text-amber-800 dark:text-amber-200 space-y-3">
                <p>{cameraError}</p>
                <button
                  type="button"
                  onClick={() => cameraFallbackInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                >
                  <ImagePlus className="w-4 h-4" />
                  <span>{t(language, 'cameraFallbackInput')}</span>
                </button>
              </div>
            ) : capturedDataUrl ? (
              <div className="space-y-3">
                <img
                  src={capturedDataUrl}
                  alt="Captured preview"
                  className="w-full max-h-72 rounded-xl border border-zinc-200 dark:border-white/10 object-contain bg-black"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={openCameraModal}
                    className="rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2 text-xs font-medium cursor-pointer"
                  >
                    {t(language, 'retakePhoto')}
                  </button>
                  <button
                    type="button"
                    onClick={confirmCameraPhoto}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                  >
                    {t(language, 'usePhoto')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="relative overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10 bg-black aspect-video flex items-center justify-center">
                  <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
                  {cameraLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-white gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                      <span>{t(language, 'cameraStarting')}</span>
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeCameraModal}
                    className="rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2 text-xs font-medium cursor-pointer"
                  >
                    {t(language, 'cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={cameraLoading}
                    onClick={captureCameraFrame}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
                  >
                    <Camera className="w-4 h-4" />
                    <span>{t(language, 'capturePhoto')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
