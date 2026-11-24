import React, { useEffect, useState } from 'react';
import {
  FolderKanban,
  Plus,
  Pencil,
  Trash2,
  MessageSquare,
  Check,
  X,
  FilePlus2,
  FileText,
  Brain,
  Download,
} from 'lucide-react';
import { api } from '../lib/api';
import { deleteMemoryFromFirestore, syncMemoryToFirestore } from '../lib/firebase';
import { triggerBrowserDownload } from '../shared/chatExport';
import { canAccessModel } from '../shared/quotas';
import type {
  BrandedModel,
  BuiltinTool,
  Conversation,
  Project,
  ProjectFileRecord,
  PublicUser,
  UserMemory,
} from '../shared/types';

interface ProjectsViewProps {
  user: PublicUser | null;
  projects: Project[];
  models: BrandedModel[];
  conversations: Conversation[];
  onRefresh: () => void;
  onOpenProjectChat: (project: Project) => void;
  onOpenConversation: (conv: Conversation) => void;
  onOpenAuth: () => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  user,
  projects,
  models,
  conversations,
  onRefresh,
  onOpenProjectChat,
  onOpenConversation,
  onOpenAuth,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [preferredModelId, setPreferredModelId] = useState('sonic-3');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [builtinTools, setBuiltinTools] = useState<BuiltinTool[]>([]);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editInst, setEditInst] = useState('');
  const [editModelId, setEditModelId] = useState('sonic-3');

  const [activeFilesProjectId, setActiveFilesProjectId] = useState<string | null>(null);
  const [projectFiles, setProjectFiles] = useState<ProjectFileRecord[]>([]);

  const [activeMemoriesProjectId, setActiveMemoriesProjectId] = useState<string | null>(null);
  const [projectMemories, setProjectMemories] = useState<UserMemory[]>([]);
  const [newProjMemory, setNewProjMemory] = useState('');

  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<string | null>(null);
  const [confirmDeleteMemoryId, setConfirmDeleteMemoryId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    api.getBuiltinTools().then((res) => setBuiltinTools(res.tools.filter((t) => t.enabled))).catch(() => null);
  }, [user?.id]);

  const loadFiles = async (pid: string) => {
    try {
      const res = await api.getProjectFiles(pid);
      setProjectFiles(res.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project files.');
      setProjectFiles([]);
    }
  };

  const loadProjectMemories = async (pid: string) => {
    try {
      const res = await api.getMemories({ scope: 'project', projectId: pid });
      setProjectMemories(res.memories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project memories.');
      setProjectMemories([]);
    }
  };

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <FolderKanban className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">Projects Workspace</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to create persistent projects with preferred models, system instructions, isolated memories, tools, and knowledge files.
        </p>
        <button
          type="button"
          onClick={onOpenAuth}
          className="mt-6 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
        >
          Sign In to Continue
        </button>
      </div>
    );
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.createProject({
        name,
        description,
        instructions,
        preferredModelId,
        enabledTools: selectedTools,
      });
      setName('');
      setDescription('');
      setInstructions('');
      setSelectedTools([]);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project.');
    } finally {
      setCreating(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    try {
      await api.updateProject(id, {
        name: editName,
        description: editDesc,
        instructions: editInst,
        preferredModelId: editModelId,
      });
      setEditingId(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project.');
    }
  };

  const handleUploadProjectFile = async (projectId: string, file: File) => {
    setError(null);
    if (file.size === 0) {
      setError('Empty (0-byte) files cannot be uploaded.');
      return;
    }
    if (file.size > 4_000_000) {
      setError('Project files must be under 4 MB.');
      return;
    }
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsDataURL(file);
      });
      const isTextLike = /\.(txt|md|json|csv|ts|tsx|js|jsx|py|sql)$/i.test(file.name) || file.type.startsWith('text/');
      const text = isTextLike ? (await file.text()).slice(0, 100_000) : '';
      await api.uploadProjectFile(projectId, {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        extractedText: text,
        dataBase64,
      });
      await loadFiles(projectId);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload project file.');
    }
  };

  const handleAddProjectMemory = async (projectId: string) => {
    if (!newProjMemory.trim()) return;
    setError(null);
    try {
      const res = await api.createMemory({
        scope: 'project',
        projectId,
        category: 'instruction',
        content: newProjMemory.trim(),
        approved: true,
      });
      syncMemoryToFirestore(res.memory).catch(() => null);
      setNewProjMemory('');
      await loadProjectMemories(projectId);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add project memory.');
    }
  };

  const handleExportProject = async (p: Project) => {
    try {
      const bundle = await api.exportProjectBundle(p.id);
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'project';
      triggerBrowserDownload(
        `loody-project-${slug}.json`,
        JSON.stringify(bundle, null, 2),
        'application/json;charset=utf-8'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export project bundle.');
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-8">
      <div className="border-b border-zinc-200 dark:border-white/10 pb-5">
        <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">Projects</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Dedicated workspaces combining preferred models, system instructions, isolated project memories, tools, and knowledge files.
        </p>
      </div>

      {/* Create Project Form */}
      <form
        onSubmit={handleCreate}
        className="rounded-2xl border border-emerald-500/25 bg-white dark:bg-[#0D110F] p-5 space-y-4"
      >
        <h3 className="font-display text-base font-semibold text-zinc-900 dark:text-white">Create Project</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="proj-name" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Project Name
            </label>
            <input
              id="proj-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Security Architecture Audit"
              className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2.5 text-sm text-zinc-900 dark:text-white focus:border-emerald-500 focus:outline-none min-h-[44px]"
            />
          </div>
          <div>
            <label htmlFor="proj-desc" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Description
            </label>
            <input
              id="proj-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Threat modeling and API boundary review"
              className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2.5 text-sm text-zinc-900 dark:text-white focus:border-emerald-500 focus:outline-none min-h-[44px]"
            />
          </div>
          <div>
            <label htmlFor="proj-model" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Preferred Model
            </label>
            <select
              id="proj-model"
              value={preferredModelId}
              onChange={(e) => setPreferredModelId(e.target.value)}
              className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2.5 text-sm text-zinc-900 dark:text-white min-h-[44px]"
            >
              {models.map((m) => {
                const access = canAccessModel({ role: user.role, plan: user.plan }, m);
                const lockSuffix = !access.allowed ? ` · ${m.requiredPlan.toUpperCase()} / Dev Locked` : '';
                return (
                  <option key={m.id} value={m.id}>
                    {m.displayName}{lockSuffix}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="proj-inst" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
            Project System Instructions (automatically applied to chats inside this project)
          </label>
          <textarea
            id="proj-inst"
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Respond with concrete OWASP references, TypeScript code examples, and concise trade-offs."
            className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2.5 text-sm text-zinc-900 dark:text-white focus:border-emerald-500 focus:outline-none"
          />
        </div>

        {builtinTools.length > 0 && (
          <div>
            <span className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              Project Tools
            </span>
            <div className="flex flex-wrap gap-2">
              {builtinTools.map((tool) => {
                const active = selectedTools.includes(tool.id);
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() =>
                      setSelectedTools((prev) =>
                        active ? prev.filter((x) => x !== tool.id) : [...prev, tool.id]
                      )
                    }
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium cursor-pointer ${
                      active
                        ? 'border-emerald-500 bg-emerald-600 text-white'
                        : 'border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-300'
                    }`}
                  >
                    {tool.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={creating}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 min-h-[44px] cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{creating ? 'Creating...' : 'Create Project'}</span>
        </button>
      </form>

      {/* Project List */}
      {projects.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0A0E0C] p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No projects yet. Create your first project above to scope AI instructions, memories, and files.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((p) => {
            const linkedConvs = conversations.filter((c) => c.projectId === p.id).slice(0, 3);
            return (
              <div key={p.id} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 flex flex-col justify-between gap-4">
                {editingId === p.id ? (
                  <div className="space-y-3">
                    <input
                      type="text"
                      aria-label="Edit project name"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full rounded-lg border border-emerald-500/40 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-sm text-zinc-900 dark:text-white"
                    />
                    <input
                      type="text"
                      aria-label="Edit project description"
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-800 dark:text-zinc-200"
                    />
                    <select
                      aria-label="Edit preferred model"
                      value={editModelId}
                      onChange={(e) => setEditModelId(e.target.value)}
                      className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white"
                    >
                      {models.map((m) => {
                        const access = canAccessModel({ role: user.role, plan: user.plan }, m);
                        const lockSuffix = !access.allowed ? ` · ${m.requiredPlan.toUpperCase()} / Dev Locked` : '';
                        return (
                          <option key={m.id} value={m.id}>
                            {m.displayName}{lockSuffix}
                          </option>
                        );
                      })}
                    </select>
                    <textarea
                      rows={3}
                      aria-label="Edit project instructions"
                      value={editInst}
                      onChange={(e) => setEditInst(e.target.value)}
                      className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-800 dark:text-zinc-200"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleSaveEdit(p.id)}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white min-h-[36px] cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Save</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-300 dark:border-white/10 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 min-h-[36px] cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Cancel</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="font-display text-base font-bold text-zinc-900 dark:text-white">{p.name}</h4>
                          <div className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                            Model: {models.find((m) => m.id === p.preferredModelId)?.displayName ?? p.preferredModelId}
                          </div>
                        </div>
                        <span className="text-xs font-mono tabular-nums text-zinc-500 text-end">
                          {p.conversationCount ?? 0} chats · {p.fileCount ?? 0} files · {p.memoryCount ?? 0} mem
                        </span>
                      </div>
                      {p.description && (
                        <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-400">{p.description}</p>
                      )}
                      {p.instructions && (
                        <p className="mt-3 rounded-xl border border-zinc-200 dark:border-white/5 bg-zinc-50 dark:bg-[#050706] p-3 text-xs text-zinc-700 dark:text-zinc-300 line-clamp-3">
                          {p.instructions}
                        </p>
                      )}

                      {linkedConvs.length > 0 && (
                        <div className="mt-3 space-y-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                            Recent Project Threads
                          </div>
                          {linkedConvs.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => onOpenConversation(c)}
                              className="w-full text-start rounded-lg border border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-[#050706] px-2.5 py-1.5 text-[11px] text-zinc-700 dark:text-zinc-300 hover:border-emerald-500/40 truncate cursor-pointer"
                            >
                              · {c.title}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Knowledge Files Drawer inside Card */}
                    {activeFilesProjectId === p.id && (
                      <div className="rounded-xl border border-emerald-500/20 bg-zinc-50 dark:bg-[#050706] p-3 space-y-2.5 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-zinc-800 dark:text-zinc-200">Project Reference Files</span>
                          <label className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white cursor-pointer">
                            <FilePlus2 className="w-3 h-3" />
                            <span>Add File</span>
                            <input
                              type="file"
                              accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.json,.csv,.ts,.js,.py"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (file) handleUploadProjectFile(p.id, file);
                              }}
                            />
                          </label>
                        </div>
                        {projectFiles.length === 0 ? (
                          <p className="text-[11px] text-zinc-500">No files linked to this project yet.</p>
                        ) : (
                          <div className="space-y-1.5">
                            {projectFiles.map((pf) => (
                              <div key={pf.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2.5 py-1.5">
                                <span className="flex items-center gap-1.5 truncate">
                                  <FileText className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                  <span className="truncate">{pf.name}</span>
                                </span>
                                <span className="inline-flex items-center gap-1.5 shrink-0">
                                  <a
                                    href={api.getProjectFileDownloadUrl(p.id, pf.id)}
                                    download={pf.name}
                                    aria-label={`Download ${pf.name}`}
                                    className="text-zinc-400 hover:text-emerald-600"
                                  >
                                    <Download className="w-3.5 h-3.5" />
                                  </a>
                                  {confirmDeleteFileId === pf.id ? (
                                    <span className="inline-flex items-center gap-1 shrink-0">
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          try {
                                            await api.deleteProjectFile(p.id, pf.id);
                                            setConfirmDeleteFileId(null);
                                            await loadFiles(p.id);
                                            onRefresh();
                                          } catch (err) {
                                            setError(err instanceof Error ? err.message : 'Failed to delete project file.');
                                          }
                                        }}
                                        className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white cursor-pointer"
                                      >
                                        Confirm
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteFileId(null)}
                                        className="rounded border border-zinc-300 dark:border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-500 cursor-pointer"
                                      >
                                        Cancel
                                      </button>
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      aria-label={`Delete ${pf.name}`}
                                      onClick={() => setConfirmDeleteFileId(pf.id)}
                                      className="text-zinc-400 hover:text-red-500 cursor-pointer"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Isolated Project Memories Drawer inside Card */}
                    {activeMemoriesProjectId === p.id && (
                      <div className="rounded-xl border border-emerald-500/20 bg-zinc-50 dark:bg-[#050706] p-3 space-y-2.5 text-xs">
                        <div className="font-semibold text-zinc-800 dark:text-zinc-200">
                          Isolated Project Memories
                        </div>
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            aria-label={`Add memory to ${p.name}`}
                            value={newProjMemory}
                            onChange={(e) => setNewProjMemory(e.target.value)}
                            placeholder="Add instruction or project fact..."
                            className="flex-1 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2.5 py-1.5 text-xs text-zinc-900 dark:text-white"
                          />
                          <button
                            type="button"
                            onClick={() => handleAddProjectMemory(p.id)}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white cursor-pointer"
                          >
                            Add
                          </button>
                        </div>
                        {projectMemories.length === 0 ? (
                          <p className="text-[11px] text-zinc-500">No memories scoped to this project yet.</p>
                        ) : (
                          <div className="space-y-1.5">
                            {projectMemories.map((pm) => (
                              <div key={pm.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2.5 py-1.5">
                                <span className="truncate text-zinc-700 dark:text-zinc-300">{pm.content}</span>
                                {confirmDeleteMemoryId === pm.id ? (
                                  <span className="inline-flex items-center gap-1 shrink-0">
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        try {
                                          await api.deleteMemory(pm.id);
                                          deleteMemoryFromFirestore(pm.id).catch(() => null);
                                          setConfirmDeleteMemoryId(null);
                                          await loadProjectMemories(p.id);
                                          onRefresh();
                                        } catch (err) {
                                          setError(err instanceof Error ? err.message : 'Failed to delete project memory.');
                                        }
                                      }}
                                      className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white cursor-pointer"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteMemoryId(null)}
                                      className="rounded border border-zinc-300 dark:border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-500 cursor-pointer"
                                    >
                                      Cancel
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    aria-label={`Delete project memory ${pm.id}`}
                                    onClick={() => setConfirmDeleteMemoryId(pm.id)}
                                    className="text-zinc-400 hover:text-red-500 cursor-pointer shrink-0"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 dark:border-white/5 pt-3">
                      <button
                        type="button"
                        onClick={() => onOpenProjectChat(p)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600/15 border border-emerald-500/30 px-3 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-600/25 min-h-[40px] cursor-pointer"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>Open in Chat</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (activeFilesProjectId === p.id) {
                            setActiveFilesProjectId(null);
                          } else {
                            setActiveFilesProjectId(p.id);
                            setActiveMemoriesProjectId(null);
                            await loadFiles(p.id);
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 dark:border-white/10 px-2.5 py-2 text-xs text-zinc-700 dark:text-zinc-300 min-h-[40px] cursor-pointer"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        <span>Files</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (activeMemoriesProjectId === p.id) {
                            setActiveMemoriesProjectId(null);
                          } else {
                            setActiveMemoriesProjectId(p.id);
                            setActiveFilesProjectId(null);
                            await loadProjectMemories(p.id);
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 dark:border-white/10 px-2.5 py-2 text-xs text-zinc-700 dark:text-zinc-300 min-h-[40px] cursor-pointer"
                      >
                        <Brain className="w-3.5 h-3.5" />
                        <span>Memories</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleExportProject(p)}
                        aria-label={`Export ${p.name}`}
                        title="Export project JSON bundle"
                        className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 dark:border-white/10 px-2.5 py-2 text-xs text-zinc-700 dark:text-zinc-300 min-h-[40px] cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(p.id);
                          setEditName(p.name);
                          setEditDesc(p.description);
                          setEditInst(p.instructions);
                          setEditModelId(p.preferredModelId || 'sonic-3');
                        }}
                        aria-label={`Edit ${p.name}`}
                        className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 dark:border-white/10 px-2.5 py-2 text-xs text-zinc-700 dark:text-zinc-300 min-h-[40px] cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {confirmDeleteProjectId === p.id ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await api.deleteProject(p.id);
                                setConfirmDeleteProjectId(null);
                                onRefresh();
                              } catch (err) {
                                setError(err instanceof Error ? err.message : 'Failed to delete project.');
                              }
                            }}
                            className="rounded-xl bg-red-600 px-2.5 py-2 text-xs font-semibold text-white min-h-[40px] cursor-pointer"
                          >
                            Confirm Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteProjectId(null)}
                            className="rounded-xl border border-zinc-200 dark:border-white/10 px-2.5 py-2 text-xs text-zinc-600 dark:text-zinc-300 min-h-[40px] cursor-pointer"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteProjectId(p.id)}
                          aria-label={`Delete ${p.name}`}
                          className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 dark:border-white/10 px-2.5 py-2 text-xs text-zinc-500 hover:text-red-500 min-h-[40px] cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
