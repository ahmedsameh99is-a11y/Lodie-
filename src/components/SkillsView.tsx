import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  Plus,
  Play,
  Trash2,
  Download,
  Upload,
  AlertCircle,
  CheckCircle2,
  Pencil,
} from 'lucide-react';
import { api } from '../lib/api';
import type { PublicUser, SkillPackage } from '../shared/types';

interface SkillsViewProps {
  user: PublicUser | null;
  onOpenAuth: () => void;
}

export const SkillsView: React.FC<SkillsViewProps> = ({ user, onOpenAuth }) => {
  const [skills, setSkills] = useState<SkillPackage[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillInput, setSkillInput] = useState('');
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<{
    skillVersion: string;
    latencyMs: number;
    toolOutputs: Array<{ toolId: string; ok: boolean; data: unknown }>;
    output: string;
  } | null>(null);

  // Create / Edit custom skill form
  const [showCreate, setShowCreate] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [confirmDeleteSkillId, setConfirmDeleteSkillId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [category, setCategory] = useState('Custom');
  const [description, setDescription] = useState('');
  const [allowedToolsText, setAllowedToolsText] = useState('utc_clock');
  const [promptTemplate, setPromptTemplate] = useState('Analyze the following input thoroughly:\n\n{{input}}');

  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadSkills = async () => {
    if (!user) return;
    try {
      const res = await api.getSkills();
      setSkills(res.skills);
      if (!selectedSkillId && res.skills.length > 0) {
        setSelectedSkillId(res.skills[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Skills registry.');
    }
  };

  useEffect(() => {
    loadSkills();
  }, [user?.id]);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Sparkles className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Skills Engine</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to inspect, create, import/export, toggle, and run structured versioned Skill Packages.
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

  const activeSkill = skills.find((s) => s.id === selectedSkillId) ?? null;

  const startEditSkill = (skill: SkillPackage) => {
    setEditingSkillId(skill.id);
    setName(skill.name);
    setVersion(skill.version);
    setCategory(skill.category);
    setDescription(skill.description);
    setAllowedToolsText(skill.allowedTools.join(', '));
    setPromptTemplate(skill.promptTemplate);
    setShowCreate(true);
    setError(null);
    setStatusMsg(null);
  };

  const resetSkillForm = () => {
    setShowCreate(false);
    setEditingSkillId(null);
    setName('');
    setVersion('1.0.0');
    setCategory('Custom');
    setDescription('');
    setAllowedToolsText('utc_clock');
    setPromptTemplate('Analyze the following input thoroughly:\n\n{{input}}');
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatusMsg(null);
    const parsedTools = allowedToolsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      if (editingSkillId) {
        const res = await api.updateSkill(editingSkillId, {
          name: name.trim(),
          version: version.trim(),
          description: description.trim(),
          category: category.trim(),
          allowedTools: parsedTools,
          promptTemplate,
        });
        resetSkillForm();
        setStatusMsg(`Updated Skill "${res.skill.name}" v${res.skill.version}.`);
        await loadSkills();
        setSelectedSkillId(res.skill.id);
      } else {
        const res = await api.createSkill({
          name: name.trim(),
          version: version.trim(),
          description: description.trim(),
          category: category.trim(),
          allowedTools: parsedTools,
          promptTemplate,
        });
        resetSkillForm();
        setStatusMsg(`Registered Skill "${res.skill.name}" v${res.skill.version}.`);
        await loadSkills();
        setSelectedSkillId(res.skill.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save skill package.');
    }
  };

  const handleImportJson = async (file: File) => {
    setError(null);
    try {
      const raw = JSON.parse(await file.text()) as {
        name: string;
        version?: string;
        description: string;
        category?: string;
        allowedTools?: string[];
        promptTemplate: string;
      };
      const res = await api.createSkill({
        name: raw.name,
        version: raw.version ?? '1.0.0',
        description: raw.description,
        category: raw.category ?? 'Imported',
        allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
        promptTemplate: raw.promptTemplate,
      });
      setStatusMsg(`Imported Skill "${res.skill.name}".`);
      await loadSkills();
      setSelectedSkillId(res.skill.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid Skill JSON manifest.');
    }
  };

  const handleExportSkill = (skill: SkillPackage) => {
    const manifest = {
      name: skill.name,
      version: skill.version,
      description: skill.description,
      category: skill.category,
      inputSchema: skill.inputSchema,
      outputSchema: skill.outputSchema,
      allowedTools: skill.allowedTools,
      promptTemplate: skill.promptTemplate,
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.skill.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSkill || !skillInput.trim()) return;
    setExecuting(true);
    setError(null);
    setExecResult(null);
    try {
      const res = await api.executeSkill(activeSkill.id, skillInput.trim());
      setExecResult({
        skillVersion: res.skillVersion,
        latencyMs: res.latencyMs,
        toolOutputs: res.toolOutputs,
        output: res.output,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Skill execution failed.');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Skills Engine</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Versioned skill packages combining prompt templates, schemas, and declared workspace tool permissions.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <label className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-3.5 py-2.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-emerald-500/40 cursor-pointer">
            <Upload className="w-3.5 h-3.5 text-emerald-500" />
            <span>Import JSON</span>
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleImportJson(file);
                e.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              if (showCreate) {
                resetSkillForm();
              } else {
                setEditingSkillId(null);
                setShowCreate(true);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Create Skill</span>
          </button>
        </div>
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

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-2xl border border-emerald-500/30 bg-white dark:bg-[#0D110F] p-5 space-y-4">
          <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">
            {editingSkillId ? 'Edit Custom Skill Package' : 'Register Custom Skill Package'}
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="skill-name" className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">Skill Name</label>
              <input
                id="skill-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="SQL Query Reviewer"
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              />
            </div>
            <div>
              <label htmlFor="skill-ver" className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">Semver</label>
              <input
                id="skill-ver"
                type="text"
                required
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs font-mono text-zinc-900 dark:text-white min-h-[40px]"
              />
            </div>
            <div>
              <label htmlFor="skill-cat" className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">Category</label>
              <input
                id="skill-cat"
                type="text"
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="skill-desc" className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">Description</label>
              <input
                id="skill-desc"
                type="text"
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Reviews parameterized SQL safety and index performance"
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              />
            </div>
            <div>
              <label htmlFor="skill-tools" className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">Allowed Tool IDs (comma-separated)</label>
              <input
                id="skill-tools"
                type="text"
                value={allowedToolsText}
                onChange={(e) => setAllowedToolsText(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs font-mono text-zinc-900 dark:text-white min-h-[40px]"
              />
            </div>
          </div>

          <div>
            <label htmlFor="skill-template" className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">
              Prompt Template (use {'{{input}}'} placeholder)
            </label>
            <textarea
              id="skill-template"
              rows={3}
              required
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 text-xs font-mono text-zinc-900 dark:text-white"
            />
          </div>

          <div className="flex gap-2">
            <button type="submit" className="rounded-xl bg-emerald-600 px-5 py-2 text-xs font-semibold text-white cursor-pointer">
              {editingSkillId ? 'Update Skill Package' : 'Save Skill Package'}
            </button>
            <button type="button" onClick={resetSkillForm} className="rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2 text-xs cursor-pointer">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Skills Directory */}
        <div className="lg:col-span-6 space-y-3">
          {skills.map((skill) => {
            const active = selectedSkillId === skill.id;
            return (
              <div
                key={skill.id}
                className={`rounded-2xl border p-4 space-y-2.5 bg-white dark:bg-[#0D110F] ${
                  active ? 'border-emerald-500/60' : 'border-zinc-200 dark:border-white/10'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSkillId(skill.id);
                      setExecResult(null);
                    }}
                    className="text-start cursor-pointer"
                  >
                    <div className="font-display text-sm font-bold text-zinc-900 dark:text-white">
                      {skill.name}{' '}
                      <span className="font-mono text-[11px] font-normal text-emerald-500">v{skill.version}</span>
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      {skill.category} · {skill.isBuiltin ? 'Built-in' : 'Custom'}
                    </div>
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={async () => {
                        await api.updateSkill(skill.id, { enabled: !skill.enabled });
                        await loadSkills();
                      }}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                        skill.enabled
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'border border-zinc-300 dark:border-white/15 text-zinc-500'
                      }`}
                    >
                      {skill.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                    <button
                      type="button"
                      title="Export Skill JSON"
                      aria-label={`Export ${skill.name}`}
                      onClick={() => handleExportSkill(skill)}
                      className="p-1.5 text-zinc-500 hover:text-emerald-500 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    {!skill.isBuiltin && (
                      <>
                        <button
                          type="button"
                          title="Edit Custom Skill"
                          aria-label={`Edit ${skill.name}`}
                          onClick={() => startEditSkill(skill)}
                          className="p-1.5 text-zinc-500 hover:text-emerald-500 cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {confirmDeleteSkillId === skill.id ? (
                          <span className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={async () => {
                                await api.deleteSkill(skill.id);
                                setConfirmDeleteSkillId(null);
                                if (selectedSkillId === skill.id) setSelectedSkillId(null);
                                await loadSkills();
                              }}
                              className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white cursor-pointer"
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteSkillId(null)}
                              className="rounded border border-zinc-300 dark:border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-500 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            title="Delete Custom Skill"
                            aria-label={`Delete ${skill.name}`}
                            onClick={() => setConfirmDeleteSkillId(skill.id)}
                            className="p-1.5 text-zinc-500 hover:text-red-500 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-300">{skill.description}</p>
                {skill.allowedTools.length > 0 && (
                  <div className="text-[11px] font-mono text-zinc-500">Tools: {skill.allowedTools.join(', ')}</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Execution Runner */}
        <div className="lg:col-span-6 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4 h-fit">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">
              {activeSkill ? `Run Skill: ${activeSkill.name}` : 'Select a Skill'}
            </h3>
            {activeSkill && (
              <span className="text-[11px] font-mono text-zinc-500">v{activeSkill.version}</span>
            )}
          </div>

          {activeSkill && (
            <form onSubmit={handleExecute} className="space-y-3">
              <div>
                <label htmlFor="skill-run-input" className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
                  Skill Input Payload (Code, CSV, Spec, or Research Question)
                </label>
                <textarea
                  id="skill-run-input"
                  rows={5}
                  required
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  placeholder="Paste code snippet, JSON, CSV rows, or task text..."
                  className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 text-xs font-mono text-zinc-900 dark:text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={executing || !activeSkill.enabled || !skillInput.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{executing ? 'Running Skill...' : 'Execute Skill'}</span>
              </button>
            </form>
          )}

          {execResult && (
            <div className="space-y-3 pt-3 border-t border-zinc-200 dark:border-white/10 text-xs">
              <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400 font-semibold">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Skill Executed (v{execResult.skillVersion})</span>
                </span>
                <span className="font-mono text-[11px] text-zinc-500">{execResult.latencyMs}ms</span>
              </div>
              {execResult.toolOutputs.length > 0 && (
                <pre className="max-h-36 overflow-auto rounded-xl bg-zinc-50 dark:bg-[#050706] p-3 font-mono text-[11px] border border-zinc-200 dark:border-white/10">
                  {JSON.stringify(execResult.toolOutputs, null, 2)}
                </pre>
              )}
              <div className="rounded-xl bg-zinc-50 dark:bg-[#050706] p-3.5 border border-zinc-200 dark:border-white/10 whitespace-pre-wrap leading-relaxed text-zinc-800 dark:text-zinc-200">
                {execResult.output}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
