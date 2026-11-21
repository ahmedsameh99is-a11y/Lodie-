import React, { useEffect, useState } from 'react';
import {
  Code2,
  Plus,
  Trash2,
  Save,
  ShieldCheck,
  Sparkles,
  FileCode2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  GitPullRequest,
  History,
} from 'lucide-react';
import { api } from '../lib/api';
import { computeUnifiedLineDiff } from '../shared/orchestrator';
import type { KoreFileRecord, KoreReviewRecord, KoreWorkspaceRecord, Project, PublicUser } from '../shared/types';

interface KoreWorkspaceProps {
  user: PublicUser | null;
  projects: Project[];
  onOpenAuth: () => void;
}

export const KoreWorkspace: React.FC<KoreWorkspaceProps> = ({ user, projects, onOpenAuth }) => {
  const [workspaces, setWorkspaces] = useState<KoreWorkspaceRecord[]>([]);
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);
  const [files, setFiles] = useState<KoreFileRecord[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [dirty, setDirty] = useState(false);

  // New workspace form
  const [showNewWs, setShowNewWs] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const [newWsDesc, setNewWsDesc] = useState('');
  const [newWsLang, setNewWsLang] = useState<'typescript' | 'javascript' | 'python' | 'web'>('typescript');
  const [newWsProjectId, setNewWsProjectId] = useState('');

  // New file input
  const [newFilePath, setNewFilePath] = useState('');

  // Check & Review states
  const [checkResult, setCheckResult] = useState<{
    executionBoundary: string;
    overallPassed: boolean;
    files: Array<{ path: string; language: string; passed: boolean; findings: Array<{ severity: string; message: string }> }>;
  } | null>(null);
  const [checking, setChecking] = useState(false);

  const [reviewInstruction, setReviewInstruction] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [reviewResult, setReviewResult] = useState<{
    id?: string;
    summary: string;
    findings: Array<{ severity: string; filePath: string; issue: string; fix: string }>;
    proposedPatch: { filePath: string; diffSummary: string; updatedContent: string } | null;
    applied?: boolean;
  } | null>(null);
  const [reviewHistory, setReviewHistory] = useState<KoreReviewRecord[]>([]);

  // Inline confirmation states (no window.confirm)
  const [confirmDeleteWsId, setConfirmDeleteWsId] = useState<string | null>(null);
  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<string | null>(null);
  const [confirmApplyPatch, setConfirmApplyPatch] = useState(false);

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspaces = async () => {
    if (!user) return;
    try {
      const res = await api.getKoreWorkspaces();
      setWorkspaces(res.workspaces);
      if (!selectedWsId && res.workspaces.length > 0) {
        setSelectedWsId(res.workspaces[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Kore workspaces.');
    }
  };

  const loadReviews = async (wsId: string) => {
    try {
      const res = await api.getKoreReviews(wsId);
      setReviewHistory(res.reviews);
    } catch {
      setReviewHistory([]);
    }
  };

  const loadFiles = async (wsId: string) => {
    try {
      const res = await api.getKoreFiles(wsId);
      setFiles(res.files);
      if (res.files.length > 0) {
        const keep = res.files.find((f) => f.path === selectedFilePath) ?? res.files[0];
        setSelectedFilePath(keep.path);
        setEditorContent(keep.content);
        setDirty(false);
      } else {
        setSelectedFilePath(null);
        setEditorContent('');
        setDirty(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load workspace files.');
    }
  };

  useEffect(() => {
    loadWorkspaces();
  }, [user?.id]);

  useEffect(() => {
    if (selectedWsId && user) {
      loadFiles(selectedWsId);
      loadReviews(selectedWsId);
      setCheckResult(null);
      setReviewResult(null);
      setConfirmApplyPatch(false);
      setConfirmDeleteFileId(null);
    } else {
      setFiles([]);
      setReviewHistory([]);
    }
  }, [selectedWsId, user?.id]);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Code2 className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Kore Code Workspace</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to create isolated multi-file code workspaces, run static AST & security verification, and review diffs with LOODY Kore.
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

  const activeWs = workspaces.find((w) => w.id === selectedWsId) ?? null;

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWsName.trim()) return;
    setError(null);
    setStatusMsg(null);
    try {
      const res = await api.createKoreWorkspace({
        name: newWsName.trim(),
        description: newWsDesc.trim(),
        language: newWsLang,
        projectId: newWsProjectId || null,
        starterFiles: true,
      });
      setNewWsName('');
      setNewWsDesc('');
      setShowNewWs(false);
      await loadWorkspaces();
      setSelectedWsId(res.workspace.id);
      setStatusMsg(`Created isolated workspace "${res.workspace.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace.');
    }
  };

  const handleSaveCurrentFile = async () => {
    if (!selectedWsId || !selectedFilePath) return;
    setError(null);
    try {
      await api.saveKoreFile(selectedWsId, { path: selectedFilePath, content: editorContent });
      setDirty(false);
      setStatusMsg(`Saved ${selectedFilePath}`);
      await loadFiles(selectedWsId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save file.');
    }
  };

  const handleCreateFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWsId || !newFilePath.trim()) return;
    setError(null);
    try {
      const res = await api.saveKoreFile(selectedWsId, {
        path: newFilePath.trim(),
        content: `// ${newFilePath.trim()}\n`,
      });
      setNewFilePath('');
      await loadFiles(selectedWsId);
      setSelectedFilePath(res.file.path);
      setEditorContent(res.file.content);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create file.');
    }
  };

  const handleRunStaticCheck = async () => {
    if (!selectedWsId) return;
    setChecking(true);
    setError(null);
    try {
      if (dirty && selectedFilePath) {
        await api.saveKoreFile(selectedWsId, { path: selectedFilePath, content: editorContent });
        setDirty(false);
      }
      const res = await api.checkKoreWorkspace(selectedWsId);
      setCheckResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Static check failed.');
    } finally {
      setChecking(false);
    }
  };

  const handleRunAiReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWsId || !reviewInstruction.trim()) return;
    setReviewing(true);
    setError(null);
    try {
      if (dirty && selectedFilePath) {
        await api.saveKoreFile(selectedWsId, { path: selectedFilePath, content: editorContent });
        setDirty(false);
      }
      const res = await api.reviewKoreWorkspace(selectedWsId, {
        instruction: reviewInstruction.trim(),
        targetPath: selectedFilePath ?? undefined,
      });
      setReviewResult(res.review);
      setConfirmApplyPatch(false);
      await loadReviews(selectedWsId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kore code review failed.');
    } finally {
      setReviewing(false);
    }
  };

  const handleApplyPatch = async () => {
    if (!selectedWsId || !reviewResult?.proposedPatch) return;
    try {
      const { filePath, updatedContent } = reviewResult.proposedPatch;
      await api.saveKoreFile(selectedWsId, { path: filePath, content: updatedContent });
      if (reviewResult.id) {
        await api.markKoreReviewApplied(selectedWsId, reviewResult.id).catch(() => null);
      }
      setStatusMsg(`Applied Kore proposed patch to ${filePath}.`);
      setConfirmApplyPatch(false);
      setReviewResult((prev) => (prev ? { ...prev, applied: true } : prev));
      await Promise.all([loadFiles(selectedWsId), loadReviews(selectedWsId)]);
      setSelectedFilePath(filePath);
      setEditorContent(updatedContent);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply proposed patch.');
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Code2 className="w-5 h-5 text-emerald-500" />
            <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Kore Engineering</h2>
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Independent coding agent architecture inside sandboxed multi-file workspaces with TypeScript AST inspection and patch diffs.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowNewWs((v) => !v)}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[42px] cursor-pointer shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>New Kore Workspace</span>
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {statusMsg && (
        <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs text-emerald-800 dark:text-emerald-200">
          {statusMsg}
        </div>
      )}

      {/* Create Workspace Panel */}
      {showNewWs && (
        <form onSubmit={handleCreateWorkspace} className="rounded-2xl border border-emerald-500/30 bg-white dark:bg-[#0D110F] p-5 space-y-4">
          <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Create Sandboxed Code Workspace</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="kore-ws-name" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Workspace Name
              </label>
              <input
                id="kore-ws-name"
                type="text"
                required
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                placeholder="Auth Middleware Service"
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              />
            </div>
            <div>
              <label htmlFor="kore-ws-lang" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Primary Language
              </label>
              <select
                id="kore-ws-lang"
                value={newWsLang}
                onChange={(e) => setNewWsLang(e.target.value as typeof newWsLang)}
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              >
                <option value="typescript">TypeScript</option>
                <option value="javascript">JavaScript</option>
                <option value="python">Python</option>
                <option value="web">Web (HTML/CSS/TS)</option>
              </select>
            </div>
            <div>
              <label htmlFor="kore-ws-proj" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Linked Project (Optional)
              </label>
              <select
                id="kore-ws-proj"
                value={newWsProjectId}
                onChange={(e) => setNewWsProjectId(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              >
                <option value="">Standalone Workspace</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="kore-ws-desc" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Description
            </label>
            <input
              id="kore-ws-desc"
              type="text"
              value={newWsDesc}
              onChange={(e) => setNewWsDesc(e.target.value)}
              placeholder="Isolated workspace for designing and verifying service modules"
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer">
              Create Workspace
            </button>
            <button
              type="button"
              onClick={() => setShowNewWs(false)}
              className="rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Workspace Selector Bar */}
      {workspaces.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-8 text-center space-y-3">
          <Code2 className="w-8 h-8 text-emerald-500 mx-auto" />
          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">No LOODY Kore workspaces yet</div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Create an isolated workspace above to start editing files and running TypeScript static & security checks.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
                  selectedWsId === ws.id
                    ? 'border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold'
                    : 'border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] text-zinc-700 dark:text-zinc-300'
                }`}
              >
                <button type="button" onClick={() => setSelectedWsId(ws.id)} className="cursor-pointer">
                  {ws.name} <span className="text-[10px] opacity-70">({ws.language})</span>
                </button>
                {confirmDeleteWsId === ws.id ? (
                  <span className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={async () => {
                        await api.deleteKoreWorkspace(ws.id);
                        setConfirmDeleteWsId(null);
                        if (selectedWsId === ws.id) setSelectedWsId(null);
                        await loadWorkspaces();
                      }}
                      className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white cursor-pointer"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteWsId(null)}
                      className="rounded border border-zinc-300 dark:border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-500 cursor-pointer"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Delete workspace ${ws.name}`}
                    onClick={() => setConfirmDeleteWsId(ws.id)}
                    className="text-zinc-400 hover:text-red-500 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {activeWs && (
            <div className="grid gap-4 lg:grid-cols-12">
              {/* Left File Tree */}
              <div className="lg:col-span-3 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Workspace Files</div>
                <div className="space-y-1">
                  {files.map((f) => (
                    <div
                      key={f.id}
                      className={`flex items-center justify-between gap-1 rounded-lg px-2.5 py-2 text-xs ${
                        selectedFilePath === f.path
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-medium'
                          : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedFilePath(f.path);
                          setEditorContent(f.content);
                          setDirty(false);
                        }}
                        className="flex-1 flex items-center gap-1.5 text-start truncate cursor-pointer"
                      >
                        <FileCode2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
                        <span className="truncate font-mono">{f.path}</span>
                      </button>
                      {confirmDeleteFileId === f.id ? (
                        <span className="inline-flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={async () => {
                              await api.deleteKoreFile(activeWs.id, f.id);
                              setConfirmDeleteFileId(null);
                              await loadFiles(activeWs.id);
                            }}
                            className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white cursor-pointer"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteFileId(null)}
                            className="rounded border border-zinc-300 dark:border-white/15 px-1 py-0.5 text-[10px] text-zinc-500 cursor-pointer"
                          >
                            No
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Delete file ${f.path}`}
                          onClick={() => setConfirmDeleteFileId(f.id)}
                          className="text-zinc-400 hover:text-red-500 p-1 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <form onSubmit={handleCreateFile} className="pt-2 border-t border-zinc-200 dark:border-white/10 flex gap-1.5">
                  <input
                    type="text"
                    aria-label="New file path"
                    value={newFilePath}
                    onChange={(e) => setNewFilePath(e.target.value)}
                    placeholder="src/utils.ts"
                    className="flex-1 min-w-0 rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2.5 py-1.5 text-xs font-mono text-zinc-900 dark:text-white"
                  />
                  <button
                    type="submit"
                    aria-label="Add file"
                    className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-500 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </form>
              </div>

              {/* Center Code Editor */}
              <div className="lg:col-span-5 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 flex flex-col space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    {selectedFilePath ?? 'No file selected'} {dirty ? '•' : ''}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!selectedFilePath || !dirty}
                      onClick={handleSaveCurrentFile}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/35 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 disabled:opacity-40 cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>Save</span>
                    </button>
                    <button
                      type="button"
                      disabled={checking || files.length === 0}
                      onClick={handleRunStaticCheck}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>{checking ? 'Checking...' : 'Static AST Check'}</span>
                    </button>
                  </div>
                </div>

                <textarea
                  aria-label="Workspace file code editor"
                  value={editorContent}
                  disabled={!selectedFilePath}
                  onChange={(e) => {
                    setEditorContent(e.target.value);
                    setDirty(true);
                  }}
                  rows={16}
                  spellCheck={false}
                  className="w-full flex-1 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 font-mono text-xs leading-relaxed text-zinc-900 dark:text-emerald-50 focus:border-emerald-500 focus:outline-none"
                />

                {checkResult && (
                  <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className={`inline-flex items-center gap-1.5 font-semibold ${checkResult.overallPassed ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                        {checkResult.overallPassed ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                        <span>{checkResult.overallPassed ? 'Static Verification Passed' : 'Findings Detected'}</span>
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-500">{checkResult.executionBoundary}</p>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {checkResult.files.map((fr) => (
                        <div key={fr.path} className="rounded-lg border border-zinc-200 dark:border-white/10 p-2 bg-white dark:bg-[#0D110F]">
                          <div className="flex justify-between font-mono text-[11px]">
                            <span>{fr.path}</span>
                            <span className={fr.passed ? 'text-emerald-500' : 'text-red-500'}>{fr.passed ? 'PASS' : 'WARN'}</span>
                          </div>
                          {fr.findings.map((fd, i) => (
                            <div key={i} className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                              [{fd.severity}] {fd.message}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right AI Kore Architect & Patch Review */}
              <div className="lg:col-span-4 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 flex flex-col space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  <Sparkles className="w-4 h-4" />
                  <span>LOODY Kore Architect</span>
                </div>

                <form onSubmit={handleRunAiReview} className="space-y-2.5">
                  <label htmlFor="kore-instruction" className="block text-xs text-zinc-600 dark:text-zinc-400">
                    Ask Kore to review bugs, security boundaries, or propose a full refactored file patch:
                  </label>
                  <textarea
                    id="kore-instruction"
                    rows={3}
                    required
                    value={reviewInstruction}
                    onChange={(e) => setReviewInstruction(e.target.value)}
                    placeholder="e.g. Audit error handling and add JSDoc plus input bounds checks in src/index.ts"
                    className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-2.5 text-xs text-zinc-900 dark:text-white focus:border-emerald-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={reviewing || files.length === 0 || !reviewInstruction.trim()}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{reviewing ? 'Analyzing Workspace...' : 'Run Kore Code Review'}</span>
                  </button>
                </form>

                {reviewResult && (
                  <div className="flex-1 overflow-y-auto space-y-3 pt-2 border-t border-zinc-200 dark:border-white/10 text-xs">
                    <div className="rounded-xl bg-zinc-50 dark:bg-[#050706] p-3 border border-zinc-200 dark:border-white/10">
                      <div className="font-semibold text-zinc-900 dark:text-white mb-1">Architecture Summary</div>
                      <p className="text-zinc-600 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">{reviewResult.summary}</p>
                    </div>

                    {reviewResult.findings.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="font-semibold text-zinc-800 dark:text-zinc-200">
                          Review Findings ({reviewResult.findings.length})
                        </div>
                        {reviewResult.findings.map((f, idx) => (
                          <div key={idx} className="rounded-xl border border-zinc-200 dark:border-white/10 p-2.5 space-y-1">
                            <div className="flex justify-between font-mono text-[11px]">
                              <span className="text-emerald-600 dark:text-emerald-400">{f.filePath}</span>
                              <span className="uppercase text-amber-500">{f.severity}</span>
                            </div>
                            <div className="text-zinc-800 dark:text-zinc-200">{f.issue}</div>
                            <div className="text-[11px] text-zinc-500">Fix: {f.fix}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {reviewResult.proposedPatch && (() => {
                      const targetFile = files.find((f) => f.path === reviewResult.proposedPatch!.filePath);
                      const diffLines = computeUnifiedLineDiff(
                        targetFile?.content ?? '',
                        reviewResult.proposedPatch!.updatedContent
                      );
                      return (
                        <div className="rounded-xl border border-emerald-500/35 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300">
                              <GitPullRequest className="w-3.5 h-3.5" />
                              <span>Unified Diff: {reviewResult.proposedPatch.filePath}</span>
                            </span>
                            {reviewResult.applied && (
                              <span className="font-mono text-[10px] uppercase text-emerald-600 dark:text-emerald-400 font-bold">
                                Applied
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{reviewResult.proposedPatch.diffSummary}</p>
                          <div className="max-h-52 overflow-auto rounded-lg bg-[#050706] p-2 font-mono text-[10px] leading-relaxed border border-white/10">
                            {diffLines.map((line, lineIdx) => (
                              <div
                                key={lineIdx}
                                className={
                                  line.type === 'add'
                                    ? 'bg-emerald-500/15 text-emerald-300 px-1'
                                    : line.type === 'remove'
                                    ? 'bg-red-500/15 text-red-300 px-1'
                                    : 'text-zinc-400 px-1'
                                }
                              >
                                <span className="inline-block w-4 select-none opacity-70">
                                  {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                                </span>
                                <span className="whitespace-pre-wrap break-all">{line.text}</span>
                              </div>
                            ))}
                          </div>
                          {!reviewResult.applied && (
                            confirmApplyPatch ? (
                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={handleApplyPatch}
                                  className="flex-1 rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                                >
                                  Confirm Overwrite
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmApplyPatch(false)}
                                  className="rounded-lg border border-zinc-300 dark:border-white/15 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmApplyPatch(true)}
                                className="w-full rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                              >
                                Review & Apply Patch
                              </button>
                            )
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {reviewHistory.length > 0 && (
                  <div className="pt-3 border-t border-zinc-200 dark:border-white/10 space-y-2 text-xs">
                    <div className="flex items-center gap-1.5 font-semibold text-zinc-600 dark:text-zinc-300">
                      <History className="w-3.5 h-3.5 text-emerald-500" />
                      <span>Persisted Review Sessions ({reviewHistory.length})</span>
                    </div>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {reviewHistory.map((rev) => (
                        <button
                          key={rev.id}
                          type="button"
                          onClick={() => {
                            setReviewResult(rev);
                            setConfirmApplyPatch(false);
                          }}
                          className="w-full text-start rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2.5 py-2 hover:border-emerald-500/40 cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{rev.instruction}</span>
                            {rev.applied && <span className="text-[10px] font-mono text-emerald-500 shrink-0">APPLIED</span>}
                          </div>
                          <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                            {rev.findings.length} findings · {rev.createdAt.slice(0, 10)}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
