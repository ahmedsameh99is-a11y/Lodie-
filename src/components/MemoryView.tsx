import React, { useEffect, useState } from 'react';
import {
  Brain,
  Plus,
  Search,
  Trash2,
  Check,
  X,
  Pencil,
  ShieldCheck,
  Database,
  AlertCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { deleteMemoryFromFirestore, syncMemoryToFirestore } from '../lib/firebase';
import type { KnowledgeCitation, MemoryScope, Project, PublicUser, UserMemory } from '../shared/types';

interface MemoryViewProps {
  user: PublicUser | null;
  projects: Project[];
  onUserUpdated: (user: PublicUser) => void;
  onOpenAuth: () => void;
}

export const MemoryView: React.FC<MemoryViewProps> = ({
  user,
  projects,
  onUserUpdated,
  onOpenAuth,
}) => {
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [indexedChunkCount, setIndexedChunkCount] = useState(0);
  const [filterScope, setFilterScope] = useState<'all' | MemoryScope>('all');
  const [filterText, setFilterText] = useState('');

  // Create form
  const [scope, setScope] = useState<MemoryScope>('user');
  const [projectId, setProjectId] = useState<string>('');
  const [category, setCategory] = useState<'preference' | 'fact' | 'instruction'>('fact');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // RAG Search Tester
  const [ragQuery, setRagQuery] = useState('');
  const [ragProjectId, setRagProjectId] = useState<string>('');
  const [ragResults, setRagResults] = useState<KnowledgeCitation[] | null>(null);
  const [ragSearching, setRagSearching] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [togglingMemory, setTogglingMemory] = useState(false);

  const loadMemories = async () => {
    if (!user) {
      setMemories([]);
      return;
    }
    try {
      const res = await api.getMemories({
        scope: filterScope === 'all' ? undefined : filterScope,
        q: filterText.trim() || undefined,
      });
      setMemories(res.memories);
      setIndexedChunkCount(res.indexedChunkCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load workspace memories.');
    }
  };

  useEffect(() => {
    loadMemories();
  }, [user?.id, filterScope]);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Brain className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">Memory & Knowledge RAG</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to manage isolated global preferences, project-scoped memories, and semantic retrieval indexing.
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

  const handleToggleMemoryEnabled = async () => {
    setTogglingMemory(true);
    setError(null);
    try {
      const res = await api.updatePreferences({ memoryEnabled: !user.memoryEnabled });
      onUserUpdated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update memory preference.');
    } finally {
      setTogglingMemory(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.createMemory({
        scope,
        projectId: scope === 'project' ? projectId : null,
        category,
        content: content.trim(),
        approved: true,
      });
      syncMemoryToFirestore(res.memory).catch(() => null);
      setContent('');
      await loadMemories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save memory.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleApprove = async (mem: UserMemory) => {
    setError(null);
    try {
      const res = await api.updateMemory(mem.id, { approved: !mem.approved });
      syncMemoryToFirestore(res.memory).catch(() => null);
      await loadMemories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update memory.');
    }
  };

  const handleSaveEdit = async (id: string) => {
    if (!editContent.trim()) return;
    try {
      const res = await api.updateMemory(id, { content: editContent.trim() });
      syncMemoryToFirestore(res.memory).catch(() => null);
      setEditingId(null);
      await loadMemories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to edit memory.');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteMemory(id);
      deleteMemoryFromFirestore(id).catch(() => null);
      await loadMemories();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete memory.');
    }
  };

  const handleRagSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ragQuery.trim()) return;
    setRagSearching(true);
    setError(null);
    try {
      const res = await api.searchRag({
        query: ragQuery.trim(),
        projectId: ragProjectId || null,
        topK: 6,
      });
      setRagResults(res.citations);
      setIndexedChunkCount(res.indexedChunkCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'RAG search failed.');
    } finally {
      setRagSearching(false);
    }
  };

  const visibleMemories = filterText.trim()
    ? memories.filter((m) => m.content.toLowerCase().includes(filterText.trim().toLowerCase()))
    : memories;

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-8">
      {/* Header & Global Memory Switch */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">
            Memory & Knowledge Retrieval (RAG)
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Explicitly approved user memories & indexed workspace knowledge chunks. Project memories remain strictly isolated to their project.
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={user.memoryEnabled}
          disabled={togglingMemory}
          onClick={handleToggleMemoryEnabled}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold min-h-[44px] shrink-0 cursor-pointer ${
            user.memoryEnabled
              ? 'bg-emerald-600 text-white hover:bg-emerald-500'
              : 'border border-zinc-300 dark:border-white/15 bg-zinc-100 dark:bg-white/5 text-zinc-700 dark:text-zinc-300'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>{user.memoryEnabled ? 'Memory Injection: Enabled' : 'Memory Injection: Disabled'}</span>
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Add Memory Form */}
      <form
        onSubmit={handleCreate}
        className="rounded-2xl border border-emerald-500/25 bg-white dark:bg-[#0D110F] p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-base font-semibold text-zinc-900 dark:text-white">
            Add Explicit Memory
          </h3>
          <span className="text-[11px] font-mono text-zinc-500">
            Indexed chunks: {indexedChunkCount}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="mem-scope" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Isolation Scope
            </label>
            <select
              id="mem-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as MemoryScope)}
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[42px]"
            >
              <option value="user">Global User Memory (All Chats)</option>
              <option value="conversation">Conversation Memory</option>
              <option value="project">Project-Scoped Memory (Isolated)</option>
              <option value="knowledge">Knowledge / Research Memory</option>
              <option value="task">Task & Workflow Memory</option>
              <option value="operational">Operational Policy Memory</option>
            </select>
          </div>

          {scope === 'project' && (
            <div>
              <label htmlFor="mem-project" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Target Project
              </label>
              <select
                id="mem-project"
                required
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[42px]"
              >
                <option value="">Select project...</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="mem-category" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Category
            </label>
            <select
              id="mem-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as 'preference' | 'fact' | 'instruction')}
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[42px]"
            >
              <option value="fact">Fact / Context</option>
              <option value="preference">Style / Preference</option>
              <option value="instruction">Persistent Instruction</option>
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="mem-content" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
            Memory Statement
          </label>
          <textarea
            id="mem-content"
            required
            rows={2}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="e.g. Always structure TypeScript API handlers with Zod validation and return explicit HTTP status codes."
            className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2.5 text-sm text-zinc-900 dark:text-white focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={saving || !content.trim() || (scope === 'project' && !projectId)}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 min-h-[44px] cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{saving ? 'Saving...' : 'Save & Approve Memory'}</span>
        </button>
      </form>

      {/* Saved Memories List */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {(['all', 'user', 'project', 'conversation', 'knowledge', 'task', 'operational'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilterScope(tab)}
                className={`rounded-xl px-3 py-1.5 text-xs font-medium min-h-[36px] capitalize cursor-pointer ${
                  filterScope === tab
                    ? 'bg-emerald-600 text-white'
                    : 'border border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-300'
                }`}
              >
                {tab === 'all' ? 'All' : tab}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute start-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              aria-label="Filter memories"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter memories..."
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] ps-9 pe-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[38px]"
            />
          </div>
        </div>

        {visibleMemories.length === 0 ? (
          <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No memories found for this scope yet.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {visibleMemories.map((m) => {
              const projName = m.projectId ? projects.find((p) => p.id === m.projectId)?.name ?? 'Project' : null;
              return (
                <div
                  key={m.id}
                  className={`rounded-2xl border p-4 space-y-3 bg-white dark:bg-[#0D110F] ${
                    m.approved ? 'border-emerald-500/25' : 'border-zinc-200 dark:border-white/10 opacity-75'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2 font-mono">
                      <span className="text-emerald-600 dark:text-emerald-400 uppercase font-semibold">
                        {m.scope === 'project' ? `Project: ${projName}` : `${m.scope} Memory`}
                      </span>
                      <span className="text-zinc-400">· {m.category}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleApprove(m)}
                      className={`rounded-lg px-2.5 py-1 font-medium cursor-pointer ${
                        m.approved
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'border border-zinc-300 dark:border-white/15 text-zinc-500'
                      }`}
                    >
                      {m.approved ? 'Approved' : 'Paused'}
                    </button>
                  </div>

                  {editingId === m.id ? (
                    <div className="space-y-2">
                      <textarea
                        rows={2}
                        aria-label="Edit memory content"
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="w-full rounded-xl border border-emerald-500/40 bg-zinc-50 dark:bg-[#050706] p-2.5 text-xs text-zinc-900 dark:text-white"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleSaveEdit(m.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Save</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 px-3 py-1.5 text-xs cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>Cancel</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-800 dark:text-zinc-200 leading-relaxed">{m.content}</p>
                  )}

                  <div className="flex items-center justify-end gap-2 border-t border-zinc-100 dark:border-white/5 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(m.id);
                        setEditContent(m.content);
                      }}
                      aria-label={`Edit memory ${m.id}`}
                      className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-white px-2 py-1 cursor-pointer"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(m.id)}
                      aria-label={`Delete memory ${m.id}`}
                      className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-red-500 px-2 py-1 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* RAG Search Tester */}
      <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-emerald-500" />
          <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">
            Semantic Knowledge & Citation Inspector (RAG)
          </h3>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Query across your indexed workspace files, project files, and approved memories to inspect exact retrieved chunks and provenance before chatting.
        </p>

        <form onSubmit={handleRagSearch} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            aria-label="Knowledge search query"
            value={ragQuery}
            onChange={(e) => setRagQuery(e.target.value)}
            placeholder="Search uploaded specs, documents, or memories..."
            className="flex-1 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3.5 py-2.5 text-xs text-zinc-900 dark:text-white min-h-[42px]"
          />
          <select
            aria-label="Scope RAG query to project"
            value={ragProjectId}
            onChange={(e) => setRagProjectId(e.target.value)}
            className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[42px]"
          >
            <option value="">Global + Workspace Files</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                Project: {p.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={ragSearching || !ragQuery.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 min-h-[42px] cursor-pointer"
          >
            <Search className="w-3.5 h-3.5" />
            <span>{ragSearching ? 'Searching...' : 'Retrieve Citations'}</span>
          </button>
        </form>

        {ragResults !== null && (
          <div className="space-y-2 pt-2">
            {ragResults.length === 0 ? (
              <p className="text-xs text-zinc-500">
                No matching knowledge chunks above threshold. Upload documents in Files or approve memories above.
              </p>
            ) : (
              ragResults.map((c) => (
                <div
                  key={c.chunkId}
                  className="rounded-xl border border-emerald-500/20 bg-zinc-50 dark:bg-[#050706] p-3 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {c.title} ({c.sourceType})
                    </span>
                    <span className="text-zinc-500">
                      Score: {c.score.toFixed(3)} · {c.retrievalMethod}
                    </span>
                  </div>
                  <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">{c.snippet}</p>
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
};
