import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import {
  Send,
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
  Menu,
  X,
  AlertCircle,
  Download,
  Share2,
  PanelRight,
  Mic,
  MicOff,
  Wrench,
  Sparkles,
  Trash2,
  RefreshCw,
  Volume2,
  VolumeX,
  BookOpen,
} from 'lucide-react';
import { api, streamChat } from '../lib/api';
import { buildConversationJson, buildConversationMarkdown, triggerBrowserDownload } from '../shared/chatExport';
import { t } from '../shared/i18n';
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
import { LoodyLogo } from './LoodyLogo';

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
  onOpenSidebar: () => void;
  onOpenModelHub: () => void;
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
  onOpenSidebar,
  onOpenModelHub,
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
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestratorMode>('auto');
  const [resolvedMode, setResolvedMode] = useState<Exclude<OrchestratorMode, 'auto'> | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);

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

  // Built-in Tools & Project files
  const [builtinTools, setBuiltinTools] = useState<BuiltinTool[]>([]);
  const [enabledToolIds, setEnabledToolIds] = useState<string[]>([]);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [projectFiles, setProjectFiles] = useState<ProjectFileRecord[]>([]);

  // Voice Speech-to-Text & Text-to-Speech
  const [listening, setListening] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [openCitationMsgId, setOpenCitationMsgId] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const docInputRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const activeModel = models.find((m) => m.id === activeModelId) ?? models[0];
  const activeConversation = conversations.find((c) => c.id === activeConvId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const supportsVision = activeModel?.inputModalities.includes('image') ?? false;

  useEffect(() => {
    if (!user) {
      setBuiltinTools([]);
      return;
    }
    api.getBuiltinTools().then((res) => setBuiltinTools(res.tools.filter((x) => x.enabled))).catch(() => null);
  }, [user?.id]);

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
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    if (!activeConvId || !user) {
      setMessages([]);
      setShareUrl(null);
      return;
    }
    api
      .getMessages(activeConvId)
      .then((res) => setMessages(res.messages))
      .catch(() => setMessages([]));
    if (activeConversation?.shareId) {
      setShareUrl(`${window.location.origin}/?share=${activeConversation.shareId}`);
    } else {
      setShareUrl(null);
    }
  }, [activeConvId, user?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  const filteredMessages = useMemo(() => {
    const q = threadQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => m.content.toLowerCase().includes(q));
  }, [messages, threadQuery]);

  const processIncomingFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    for (const file of files) {
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
        if (file.size > 4_000_000) {
          setError(`Image "${file.name}" exceeds 4 MB.`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = String(reader.result ?? '').split(',')[1] ?? '';
          setAttachments((prev) => [
            ...prev.slice(0, 2),
            { mimeType: file.type, dataBase64: base64, name: file.name, sizeBytes: file.size },
          ]);
        };
        reader.readAsDataURL(file);
        if (!supportsVision) {
          const visionModel = models.find((m) => m.inputModalities.includes('image') && m.availability === 'operational');
          if (visionModel) {
            onSelectModel(visionModel.id);
          }
        }
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

    setError(null);
    setFallbackNotice(null);
    setLastFailedPrompt(null);
    setStreaming(true);
    setStreamingText('');

    const controller = new AbortController();
    abortRef.current = controller;

    if (params.mode !== 'regenerate' && params.mode !== 'continue') {
      const tempUserMsg: ChatMessage = {
        id: `temp-${Date.now()}`,
        conversationId: params.convId ?? activeConvId ?? 'pending',
        role: 'user',
        content: params.promptText,
        attachments: [
          ...attachments.map((a) => ({ mimeType: a.mimeType, name: a.name, kind: 'image' as const })),
          ...docAttachments.map((d) => ({ mimeType: d.mimeType, name: d.name, kind: 'document' as const })),
        ],
        createdAt: new Date().toISOString(),
      };
      if (params.mode === 'edit_resend' && params.targetMessageId) {
        const idx = messages.findIndex((m) => m.id === params.targetMessageId);
        if (idx >= 0) {
          setMessages([...messages.slice(0, idx), tempUserMsg]);
        }
      } else {
        setMessages((prev) => [...prev, tempUserMsg]);
      }
    } else if (params.mode === 'regenerate') {
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        setMessages((prev) => prev.slice(0, -1));
      }
    }

    let resolvedConvId = params.convId ?? activeConvId ?? undefined;

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
          onSelectConvId(meta.conversationId);
          if (meta.resolvedMode) {
            setResolvedMode(meta.resolvedMode);
          }
          if (meta.fallbackFromModelId && meta.modelId) {
            const origName = models.find((x) => x.id === meta.fallbackFromModelId)?.displayName ?? meta.fallbackFromModelId;
            const nextName = models.find((x) => x.id === meta.modelId)?.displayName ?? meta.modelId;
            const detail = meta.fallbackReason
              ? ` (${meta.fallbackErrorClass ? `${meta.fallbackErrorClass}: ` : ''}${meta.fallbackReason})`
              : '';
            setFallbackNotice(`${origName} switched to ${nextName}${detail}`);
          }
        },
        onChunk: (chunk) => {
          setStreamingText((prev) => prev + chunk);
        },
        onDone: async (done) => {
          if (done.quota) onUsageUpdate(done.quota);
          const cid = done.conversationId || resolvedConvId;
          if (cid) {
            onSelectConvId(cid);
            const refreshed = await api.getMessages(cid);
            setMessages(refreshed.messages);
          }
          await onRefreshConversations();
        },
        onError: (errMsg) => {
          setError(errMsg);
          setLastFailedPrompt(params.promptText);
        },
      });
      setAttachments([]);
      setDocAttachments([]);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Streaming interrupted.');
        setLastFailedPrompt(params.promptText);
      }
    } finally {
      setStreaming(false);
      setStreamingText('');
      abortRef.current = null;
    }
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
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

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
  };

  const handleToggleSpeak = (msgId: string, text: string) => {
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
  };

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

  const markdownComponents = {
    pre({ children }: { children?: React.ReactNode }) {
      const extractText = (node: React.ReactNode): string => {
        if (typeof node === 'string') return node;
        if (Array.isArray(node)) return node.map(extractText).join('');
        if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
          return extractText(node.props.children);
        }
        return '';
      };
      const codeStr = extractText(children);
      const codeId = `code-${codeStr.slice(0, 24)}-${codeStr.length}`;
      return (
        <div className="my-3 overflow-hidden rounded-xl border border-zinc-200 dark:border-emerald-500/20 bg-zinc-50 dark:bg-[#050706]">
          <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/10 bg-zinc-100/80 dark:bg-[#0A0E0C] px-3 py-1.5 text-[11px] text-zinc-500">
            <span className="font-mono">code</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleCopy(codeId, codeStr)}
                className="inline-flex items-center gap-1 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer"
              >
                {copiedId === codeId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copiedId === codeId ? 'Copied' : 'Copy'}</span>
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
    },
  };

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
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={onOpenSidebar}
              aria-label="Open workspace sidebar"
              className="lg:hidden flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#0D110F] text-zinc-700 dark:text-zinc-200 cursor-pointer"
            >
              <Menu className="w-4 h-4" />
            </button>

            {/* Quick Inline Model Selector */}
            <div className="relative flex items-center">
              <label htmlFor="chat-model-select" className="sr-only">
                Select model
              </label>
              <select
                id="chat-model-select"
                value={activeModelId}
                onChange={(e) => onSelectModel(e.target.value)}
                className="appearance-none rounded-lg border border-emerald-500/30 bg-white dark:bg-[#0D110F] ps-3 pe-8 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400 focus:border-emerald-500 focus:outline-none min-h-[38px] cursor-pointer"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.availability === 'operational' ? m.speedClass : 'Awaiting Config'})
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-400 absolute end-2.5 pointer-events-none" />
            </div>

            {/* Orchestration Mode Selector */}
            <div className="relative flex items-center">
              <label htmlFor="chat-orchestrator-mode" className="sr-only">
                Orchestration Mode
              </label>
              <select
                id="chat-orchestrator-mode"
                aria-label="Orchestration Mode"
                value={orchestrationMode}
                onChange={(e) => setOrchestrationMode(e.target.value as OrchestratorMode)}
                className="appearance-none rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] ps-2.5 pe-7 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 focus:border-emerald-500 focus:outline-none min-h-[38px] cursor-pointer"
              >
                <option value="auto">Mode: Auto</option>
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

            {resolvedMode && (
              <span className="hidden xl:inline-flex items-center rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-mono uppercase text-emerald-700 dark:text-emerald-300">
                {resolvedMode.replace('_', ' ')}
              </span>
            )}

            <button
              type="button"
              onClick={onOpenModelHub}
              className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:border-emerald-500/40 whitespace-nowrap cursor-pointer"
            >
              <Sparkles className="w-3 h-3 text-emerald-500" />
              <span>Model Hub</span>
            </button>
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
                const isLong = m.content.length > 2200;
                const isExpanded = expandedMsgs[m.id] ?? true;
                const displayBody = isLong && !isExpanded ? `${m.content.slice(0, 1200)}...` : m.content;

                return (
                  <article
                    key={m.id}
                    className={`rounded-2xl p-4 sm:p-5 ${
                      m.role === 'user'
                        ? 'bg-emerald-50/70 dark:bg-[#0F1713] border border-emerald-500/25 ms-auto max-w-[92%] sm:max-w-[82%]'
                        : 'bg-white dark:bg-[#0A0E0C] border border-zinc-200 dark:border-white/8'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                        {m.role === 'user'
                          ? user?.displayName ?? 'You'
                          : models.find((x) => x.id === m.modelId)?.displayName ?? 'LOODY'}
                      </span>
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

                    {editingMsgId === m.id ? (
                      <div className="space-y-2">
                        <textarea
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          rows={3}
                          className="w-full rounded-xl border border-emerald-500/40 bg-white dark:bg-[#050706] p-3 text-sm text-zinc-900 dark:text-white focus:outline-none"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              const next = editingText.trim();
                              setEditingMsgId(null);
                              if (next && activeConvId) {
                                runStream({
                                  promptText: next,
                                  mode: 'edit_resend',
                                  targetMessageId: m.id,
                                  convId: activeConvId,
                                });
                              }
                            }}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 min-h-[36px] cursor-pointer"
                          >
                            {t(language, 'saveAndResend')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingMsgId(null)}
                            className="rounded-lg border border-zinc-300 dark:border-white/10 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 min-h-[36px] cursor-pointer"
                          >
                            {t(language, 'cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="prose prose-zinc dark:prose-invert prose-sm max-w-none prose-code:text-emerald-700 dark:prose-code:text-emerald-300">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkMath]}
                          rehypePlugins={[rehypeKatex, rehypeHighlight]}
                          components={markdownComponents}
                        >
                          {displayBody}
                        </ReactMarkdown>
                      </div>
                    )}

                    {isLong && (
                      <button
                        type="button"
                        onClick={() => setExpandedMsgs((prev) => ({ ...prev, [m.id]: !isExpanded }))}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 cursor-pointer"
                      >
                        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                        <span>{isExpanded ? 'Collapse long response' : 'Expand full response'}</span>
                      </button>
                    )}

                    {/* Knowledge Citations */}
                    {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
                      <div className="mt-3 rounded-xl border border-emerald-500/20 bg-zinc-50 dark:bg-[#050706] p-3 text-xs space-y-2">
                        <button
                          type="button"
                          onClick={() => setOpenCitationMsgId((prev) => (prev === m.id ? null : m.id))}
                          className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300 cursor-pointer"
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          <span>
                            {m.citations.length} Knowledge Source{m.citations.length === 1 ? '' : 's'} Cited
                          </span>
                        </button>
                        {openCitationMsgId === m.id && (
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

                    {/* Message Actions */}
                    <div className="mt-3 flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-100 dark:border-white/5">
                      <button
                        type="button"
                        onClick={() => handleCopy(m.id, m.content)}
                        className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
                      >
                        {copiedId === m.id ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedId === m.id ? t(language, 'copied') : t(language, 'copy')}</span>
                      </button>

                      {m.role === 'assistant' && (
                        <button
                          type="button"
                          onClick={() => handleToggleSpeak(m.id, m.content)}
                          className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded cursor-pointer ${
                            speakingMsgId === m.id
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/5'
                          }`}
                        >
                          {speakingMsgId === m.id ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                          <span>{speakingMsgId === m.id ? t(language, 'stopSpeaking') : t(language, 'readAloud')}</span>
                        </button>
                      )}

                      {m.role === 'user' && !streaming && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMsgId(m.id);
                            setEditingText(m.content);
                          }}
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
                            onClick={() => {
                              const lastUser = [...messages].reverse().find((x) => x.role === 'user');
                              if (lastUser && activeConvId) {
                                runStream({ promptText: lastUser.content, mode: 'regenerate', convId: activeConvId });
                              }
                            }}
                            className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 px-2 py-1 rounded hover:bg-emerald-500/10 cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>{t(language, 'regenerate')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (activeConvId) {
                                runStream({
                                  promptText: 'Continue',
                                  mode: 'continue',
                                  convId: activeConvId,
                                });
                              }
                            }}
                            className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-300 px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
                          >
                            <span>{t(language, 'continueResponse')}</span>
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}

              {streaming && (
                <article className="rounded-2xl bg-white dark:bg-[#0A0E0C] border border-emerald-500/35 p-4 sm:p-5">
                  <div className="mb-2 flex items-center justify-between text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    <span>{activeModel?.displayName ?? 'LOODY'} · Generating...</span>
                    {resolvedMode && (
                      <span className="font-mono text-[10px] uppercase text-zinc-500 dark:text-zinc-400">
                        {resolvedMode.replace('_', ' ')}
                      </span>
                    )}
                  </div>
                  <div className="prose prose-zinc dark:prose-invert prose-sm max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex, rehypeHighlight]}
                    >
                      {streamingText || '...'}
                    </ReactMarkdown>
                  </div>
                </article>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* Error Banner with Retry */}
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
              <div className="flex items-center gap-2">
                {lastFailedPrompt && !streaming && (
                  <button
                    type="button"
                    onClick={() => runStream({ promptText: lastFailedPrompt, mode: 'send' })}
                    className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-500 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>{t(language, 'retry')}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setError(null)}
                  aria-label="Dismiss error"
                  className="text-red-500 hover:text-red-700 dark:text-red-300 dark:hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Composer */}
        <div className="border-t border-zinc-200 dark:border-white/8 bg-white dark:bg-[#080B09] px-3 sm:px-6 py-3">
          <div className="mx-auto max-w-3xl">
            {(attachments.length > 0 || docAttachments.length > 0 || enabledToolIds.length > 0) && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((att, idx) => (
                  <div
                    key={`img-${idx}`}
                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-50 dark:bg-[#0D110F] px-2.5 py-1 text-xs text-emerald-800 dark:text-emerald-200"
                  >
                    <span className="truncate max-w-[140px]">Img: {att.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${att.name}`}
                      onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                      className="cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {docAttachments.map((docItem, idx) => (
                  <div
                    key={`doc-${idx}`}
                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-50 dark:bg-[#0D110F] px-2.5 py-1 text-xs text-emerald-800 dark:text-emerald-200"
                  >
                    <span className="truncate max-w-[140px]">Doc: {docItem.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${docItem.name}`}
                      onClick={() => setDocAttachments((prev) => prev.filter((_, i) => i !== idx))}
                      className="cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {enabledToolIds.map((tid) => (
                  <div
                    key={`tool-${tid}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-white/15 bg-zinc-100 dark:bg-white/5 px-2.5 py-1 text-[11px] text-zinc-700 dark:text-zinc-200"
                  >
                    <Wrench className="w-3 h-3 text-emerald-500" />
                    <span>{tid}</span>
                    <button
                      type="button"
                      aria-label={`Disable tool ${tid}`}
                      onClick={() => setEnabledToolIds((prev) => prev.filter((x) => x !== tid))}
                      className="cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Tool Picker Popover */}
            {toolMenuOpen && builtinTools.length > 0 && (
              <div className="mb-2 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#0D110F] p-3 text-xs space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-800 dark:text-zinc-200">Built-in Context Tools</span>
                  <button
                    type="button"
                    onClick={() => setToolMenuOpen(false)}
                    aria-label="Close tool menu"
                    className="text-zinc-400 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {builtinTools.map((tool) => {
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
                        className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium cursor-pointer ${
                          active
                            ? 'border-emerald-500 bg-emerald-600 text-white'
                            : 'border-zinc-200 dark:border-white/10 bg-white dark:bg-[#050706] text-zinc-700 dark:text-zinc-300'
                        }`}
                      >
                        {tool.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex items-end gap-1.5 rounded-2xl border border-emerald-500/25 bg-zinc-50 dark:bg-[#050706] p-2 focus-within:border-emerald-500/70">
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

              <button
                type="button"
                title={supportsVision ? t(language, 'attachImage') : 'Attaches image & switches to LOODY Vision 1'}
                aria-label={t(language, 'attachImage')}
                onClick={() => imageInputRef.current?.click()}
                className="flex h-11 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-white/5 hover:text-emerald-600 cursor-pointer"
              >
                <ImagePlus className="w-4 h-4" />
              </button>

              <button
                type="button"
                title={t(language, 'attachFile')}
                aria-label={t(language, 'attachFile')}
                onClick={() => docInputRef.current?.click()}
                className="flex h-11 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-white/5 hover:text-emerald-600 cursor-pointer"
              >
                <FilePlus2 className="w-4 h-4" />
              </button>

              <button
                type="button"
                title="Toggle built-in tools"
                aria-label="Toggle workspace tools"
                onClick={() => setToolMenuOpen((v) => !v)}
                className={`hidden sm:flex h-11 w-10 shrink-0 items-center justify-center rounded-xl cursor-pointer ${
                  enabledToolIds.length > 0
                    ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                    : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-white/5'
                }`}
              >
                <Wrench className="w-4 h-4" />
              </button>

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
                className="flex-1 resize-none bg-transparent py-2.5 px-1 text-sm leading-5 text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none min-h-[44px] max-h-36"
              />

              <button
                type="button"
                onClick={handleVoiceToggle}
                aria-label={t(language, 'voiceInput')}
                title={listening ? 'Stop voice capture' : t(language, 'voiceInput')}
                className={`flex h-11 w-10 shrink-0 items-center justify-center rounded-xl cursor-pointer ${
                  listening
                    ? 'bg-red-500/15 text-red-500'
                    : 'text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-white/5 hover:text-emerald-600'
                }`}
              >
                {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>

              {streaming ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  aria-label={t(language, 'stop')}
                  className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-red-600 px-3.5 text-xs font-semibold text-white hover:bg-red-500 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>{t(language, 'stop')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  aria-label={t(language, 'send')}
                  className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  <span className="hidden sm:inline">{t(language, 'send')}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Optional Toggleable Right Context Panel */}
      {contextPanelOpen && (
        <aside className="hidden md:flex w-72 shrink-0 flex-col border-s border-zinc-200 dark:border-white/10 bg-white dark:bg-[#080B09] p-4 overflow-y-auto space-y-5 text-xs">
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
              <div className="text-zinc-500 font-mono text-[11px]">{activeModel?.provider} · {activeModel?.upstreamModelId}</div>
              <div className="text-[11px] text-zinc-500">
                Fallback routing: {user?.allowFallback ? 'Enabled' : 'Disabled'}
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
    </div>
  );
};
