import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  FileText,
  Upload,
  Trash2,
  Eye,
  X,
  AlertCircle,
  Search,
  Download,
  Sparkles,
  GitCompare,
  MessageSquarePlus,
  Send,
} from 'lucide-react';
import { api } from '../lib/api';
import { toSafeMarkdownUrl } from '../shared/safeUrl';
import type { DocumentAttachment, FileCategory, PublicUser, WorkspaceFileRecord } from '../shared/types';

interface FilesViewProps {
  user: PublicUser | null;
  onUseInChat: (doc: DocumentAttachment) => void;
  onOpenAuth: () => void;
}

const DISALLOWED_EXECUTABLE_EXT = /\.(exe|dll|bat|cmd|msi|scr|com|vbs|pif|cpl|jar|apk|dmg)$/i;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|csv|tsv|ts|tsx|js|jsx|py|sql|html|css|yml|yaml|xml|log)$/i;

export const FilesView: React.FC<FilesViewProps> = ({ user, onUseInChat, onOpenAuth }) => {
  const [files, setFiles] = useState<WorkspaceFileRecord[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<FileCategory | ''>('');
  const [uploadFolder, setUploadFolder] = useState('');

  const [previewFile, setPreviewFile] = useState<WorkspaceFileRecord | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [analysisQuestion, setAnalysisQuestion] = useState('');
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);

  // Compare two files modal
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');
  const [compareFocus, setCompareFocus] = useState('');
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadFiles = async () => {
    if (!user) {
      setFiles([]);
      return;
    }
    try {
      const res = await api.getFiles({
        q: searchQ.trim() || undefined,
        category: categoryFilter || undefined,
      });
      setFiles(res.files);
    } catch {
      setFiles([]);
    }
  };

  useEffect(() => {
    loadFiles();
  }, [user?.id, categoryFilter]);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <FileText className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">Workspace Files</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to upload PDF, DOCX, XLSX, CSV, code, images, audio, and video for isolated search, preview, summarization, and comparison.
        </p>
        <button
          type="button"
          onClick={onOpenAuth}
          className="mt-6 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
        >
          Sign In
        </button>
      </div>
    );
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);

    if (DISALLOWED_EXECUTABLE_EXT.test(file.name)) {
      setError('Executable binaries (.exe, .bat, .dll, .apk, etc.) are blocked for workspace security.');
      return;
    }
    if (file.size === 0) {
      setError('Empty (0-byte) files cannot be uploaded.');
      return;
    }
    if (file.size > 5_000_000) {
      setError('Workspace files must be under 5 MB.');
      return;
    }

    setUploading(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('Failed to read file bytes.'));
        reader.readAsDataURL(file);
      });

      const isTextLike =
        file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXTENSIONS.test(file.name);
      const extractedText = isTextLike ? (await file.text()).slice(0, 140_000) : '';

      await api.uploadFile({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        extractedText,
        dataBase64,
        folder: uploadFolder.trim(),
      });
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file.');
    } finally {
      setUploading(false);
    }
  };

  const handleSummarize = async (f: WorkspaceFileRecord) => {
    setAnalyzingId(f.id);
    setError(null);
    try {
      const res = await api.summarizeFile(f.id);
      setFiles((prev) => prev.map((x) => (x.id === f.id ? res.file : x)));
      if (previewFile?.id === f.id) setPreviewFile(res.file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Summarization failed.');
    } finally {
      setAnalyzingId(null);
    }
  };

  const handleAnalyzeQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!previewFile || !analysisQuestion.trim()) return;
    setAnalyzingId(previewFile.id);
    setError(null);
    try {
      const res = await api.analyzeFile(previewFile.id, analysisQuestion.trim());
      setAnalysisResult(res.analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed.');
    } finally {
      setAnalyzingId(null);
    }
  };

  const handleCompare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!compareA || !compareB || compareA === compareB) {
      setError('Select two different files to compare.');
      return;
    }
    setComparing(true);
    setError(null);
    try {
      const res = await api.compareFiles(compareA, compareB, compareFocus.trim() || undefined);
      setCompareResult(res.comparison);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comparison failed.');
    } finally {
      setComparing(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">Workspace Files</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Upload PDF, DOCX, XLSX, CSV, Markdown, code, images, audio, or video. Files are indexed for RAG and isolated per account.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            aria-label="Optional folder for upload"
            value={uploadFolder}
            onChange={(e) => setUploadFolder(e.target.value)}
            placeholder="Folder (optional)"
            className="rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-3 py-2 text-xs text-zinc-900 dark:text-white w-36 min-h-[42px]"
          />
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.sql,.yml,.yaml,.log,image/*,audio/*,video/*"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 min-h-[42px] cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            <span>{uploading ? 'Processing...' : 'Upload File'}</span>
          </button>
          {files.length >= 2 && (
            <button
              type="button"
              onClick={() => {
                setCompareA(files[0].id);
                setCompareB(files[1].id);
                setCompareResult(null);
                setCompareOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/35 px-3.5 py-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 min-h-[42px] cursor-pointer"
            >
              <GitCompare className="w-4 h-4" />
              <span>Compare Two Files</span>
            </button>
          )}
        </div>
      </div>

      {/* Search & Category Bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            loadFiles();
          }}
          className="relative flex-1 flex gap-2"
        >
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute start-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              aria-label="Search uploaded files"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Search filenames, summaries, or extracted document text..."
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] ps-9 pe-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
            />
          </div>
          <button
            type="submit"
            className="rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-emerald-500/40 min-h-[40px] cursor-pointer"
          >
            Search
          </button>
        </form>

        <select
          aria-label="Filter files by category"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as FileCategory | '')}
          className="rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
        >
          <option value="">All Categories</option>
          <option value="document">Documents (PDF/DOCX)</option>
          <option value="spreadsheet">Spreadsheets (XLSX/CSV)</option>
          <option value="code">Code & Config</option>
          <option value="text">Notes & Markdown</option>
          <option value="image">Images</option>
          <option value="audio">Audio</option>
          <option value="video">Video</option>
        </select>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {files.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No workspace files match this view. Click Upload File above to add PDFs, spreadsheets, documents, or media.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {files.map((f) => (
            <div
              key={f.id}
              className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 flex flex-col justify-between gap-3"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-4 h-4 text-emerald-500 shrink-0" />
                    <h3 className="font-display text-sm font-semibold text-zinc-900 dark:text-white truncate">
                      {f.name}
                    </h3>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-zinc-400 shrink-0">
                    {(f.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] font-mono">
                  <span className="text-emerald-600 dark:text-emerald-400 uppercase">{f.fileCategory}</span>
                  {f.folder && <span className="text-zinc-500">· /{f.folder}</span>}
                </div>

                {f.summary ? (
                  <p className="mt-2 rounded-xl border border-emerald-500/20 bg-emerald-50/40 dark:bg-[#050706] p-2.5 text-[11px] text-zinc-700 dark:text-zinc-200 line-clamp-3">
                    {f.summary}
                  </p>
                ) : (
                  <p className="mt-2 rounded-xl border border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-[#050706] p-2.5 text-[11px] font-mono text-zinc-600 dark:text-zinc-300 line-clamp-3">
                    {f.extractedText || 'Binary media asset'}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-zinc-100 dark:border-white/5 pt-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setAnalysisQuestion('');
                      setAnalysisResult(null);
                      setPreviewFile(f);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-emerald-500/40 min-h-[34px] cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>Preview</span>
                  </button>

                  {f.extractedText && (
                    <>
                      <button
                        type="button"
                        disabled={analyzingId === f.id}
                        onClick={() => handleSummarize(f)}
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 min-h-[34px] cursor-pointer"
                      >
                        <Sparkles className="w-3 h-3" />
                        <span>{analyzingId === f.id ? '...' : 'Summarize'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          onUseInChat({
                            name: f.name,
                            mimeType: f.mimeType,
                            sizeBytes: f.sizeBytes,
                            extractedText: f.extractedText.slice(0, 48_000),
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 min-h-[34px] cursor-pointer"
                      >
                        <MessageSquarePlus className="w-3 h-3" />
                        <span>Chat</span>
                      </button>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  <a
                    href={api.getFileDownloadUrl(f.id)}
                    download={f.name}
                    aria-label={`Download ${f.name}`}
                    className="inline-flex items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 p-1.5 text-zinc-500 hover:text-emerald-600 min-h-[34px] min-w-[34px]"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                  {confirmDeleteFileId === f.id ? (
                    <span className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={async () => {
                          await api.deleteFile(f.id);
                          setConfirmDeleteFileId(null);
                          if (previewFile?.id === f.id) setPreviewFile(null);
                          loadFiles();
                        }}
                        className="rounded-lg bg-red-600 px-2 py-1 text-[11px] font-semibold text-white cursor-pointer"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteFileId(null)}
                        className="rounded-lg border border-zinc-200 dark:border-white/10 px-2 py-1 text-[11px] text-zinc-500 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${f.name}`}
                      onClick={() => setConfirmDeleteFileId(f.id)}
                      className="inline-flex items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 p-1.5 text-zinc-500 hover:text-red-500 min-h-[34px] min-w-[34px] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview & Analyze Modal */}
      {previewFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${previewFile.name}`}
        >
          <div className="w-full max-w-3xl max-h-[90dvh] flex flex-col rounded-2xl border border-emerald-500/25 bg-white dark:bg-[#0D110F] p-5 shadow-2xl space-y-4 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/10 pb-3">
              <div>
                <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">{previewFile.name}</h3>
                <p className="text-xs text-zinc-500">
                  {previewFile.mimeType} · {previewFile.sizeBytes.toLocaleString()} bytes · {previewFile.fileCategory}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={api.getFileDownloadUrl(previewFile.id)}
                  download={previewFile.name}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </a>
                <button
                  type="button"
                  aria-label="Close file preview"
                  onClick={() => setPreviewFile(null)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {previewFile.fileCategory === 'image' && (
              <img
                src={api.getFileDownloadUrl(previewFile.id, true)}
                alt={previewFile.name}
                className="max-h-72 w-auto mx-auto rounded-xl border border-zinc-200 dark:border-white/10 object-contain"
              />
            )}
            {previewFile.fileCategory === 'audio' && (
              <audio controls src={api.getFileDownloadUrl(previewFile.id, true)} className="w-full" />
            )}
            {previewFile.fileCategory === 'video' && (
              <video controls src={api.getFileDownloadUrl(previewFile.id, true)} className="max-h-72 w-full rounded-xl" />
            )}

            {previewFile.summary && (
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-50/40 dark:bg-[#050706] p-3.5 text-xs space-y-1">
                <div className="font-semibold text-emerald-700 dark:text-emerald-400">AI Executive Summary</div>
                <div className="prose prose-zinc dark:prose-invert prose-xs max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={toSafeMarkdownUrl}>
                    {previewFile.summary}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {previewFile.extractedText && (
              <>
                <pre className="max-h-60 overflow-auto rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4 text-xs font-mono text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap">
                  {previewFile.extractedText}
                </pre>

                <form onSubmit={handleAnalyzeQuestion} className="flex gap-2">
                  <input
                    type="text"
                    aria-label="Ask AI about this document"
                    value={analysisQuestion}
                    onChange={(e) => setAnalysisQuestion(e.target.value)}
                    placeholder="Ask a targeted question about this document..."
                    className="flex-1 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
                  />
                  <button
                    type="submit"
                    disabled={analyzingId === previewFile.id || !analysisQuestion.trim()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 min-h-[40px] cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{analyzingId === previewFile.id ? 'Analyzing...' : 'Analyze'}</span>
                  </button>
                </form>

                {analysisResult && (
                  <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4 prose prose-zinc dark:prose-invert prose-xs max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={toSafeMarkdownUrl}>
                      {analysisResult}
                    </ReactMarkdown>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Compare Two Files Modal */}
      {compareOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Compare two files"
        >
          <div className="w-full max-w-2xl max-h-[90dvh] overflow-y-auto rounded-2xl border border-emerald-500/25 bg-white dark:bg-[#0D110F] p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/10 pb-3">
              <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Compare Two Files</h3>
              <button
                type="button"
                aria-label="Close comparison dialog"
                onClick={() => setCompareOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCompare} className="space-y-3 text-xs">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="cmp-a" className="block font-medium mb-1">Document A</label>
                  <select
                    id="cmp-a"
                    value={compareA}
                    onChange={(e) => setCompareA(e.target.value)}
                    className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-zinc-900 dark:text-white min-h-[40px]"
                  >
                    {files.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="cmp-b" className="block font-medium mb-1">Document B</label>
                  <select
                    id="cmp-b"
                    value={compareB}
                    onChange={(e) => setCompareB(e.target.value)}
                    className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-zinc-900 dark:text-white min-h-[40px]"
                  >
                    {files.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <input
                type="text"
                aria-label="Optional comparison focus"
                value={compareFocus}
                onChange={(e) => setCompareFocus(e.target.value)}
                placeholder="Optional focus (e.g. compare security requirements or pricing discrepancies)"
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-zinc-900 dark:text-white min-h-[40px]"
              />
              <button
                type="submit"
                disabled={comparing}
                className="rounded-xl bg-emerald-600 px-5 py-2.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 min-h-[40px] cursor-pointer"
              >
                {comparing ? 'Comparing...' : 'Run Comparison'}
              </button>
            </form>

            {compareResult && (
              <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4 prose prose-zinc dark:prose-invert prose-xs max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={toSafeMarkdownUrl}>
                  {compareResult}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
