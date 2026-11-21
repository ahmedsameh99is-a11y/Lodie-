import React, { useEffect, useState } from 'react';
import {
  Briefcase,
  Play,
  ShieldCheck,
  XCircle,
  CheckCircle2,
  Plus,
  Copy,
  Trash2,
  Clock,
  Pause,
  AlertCircle,
  Bot,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AgentProfile, AgentRunRecord, Project, PublicUser, SpecialistAgentId, WorkspaceTask } from '../shared/types';

interface WorkAgentsViewProps {
  user: PublicUser | null;
  projects: Project[];
  onOpenAuth: () => void;
}

export const WorkAgentsView: React.FC<WorkAgentsViewProps> = ({ user, projects, onOpenAuth }) => {
  const [tab, setTab] = useState<'agents' | 'tasks'>('agents');

  // Agents state
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [goal, setGoal] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<SpecialistAgentId[]>(['research', 'work']);
  const [agentProjectId, setAgentProjectId] = useState('');
  const [requireApproval, setRequireApproval] = useState(true);
  const [runningAgent, setRunningAgent] = useState(false);

  // Tasks state
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [templates, setTemplates] = useState<
    Array<{
      id: string;
      name: string;
      priority: 'low' | 'medium' | 'high';
      description: string;
      recurringCron?: string;
      subtasks: string[];
      milestones: string[];
    }>
  >([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [newTaskSubtasks, setNewTaskSubtasks] = useState('');
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAll = async () => {
    if (!user) return;
    try {
      const [pRes, rRes, tRes, tplRes] = await Promise.all([
        api.getAgentProfiles(),
        api.getAgentRuns(),
        api.getTasks(),
        api.getTaskTemplates(),
      ]);
      setProfiles(pRes.agents);
      setRuns(rRes.runs);
      setTasks(tRes.tasks);
      setTemplates(tplRes.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Agents & Work state.');
    }
  };

  useEffect(() => {
    loadAll();
  }, [user?.id]);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Briefcase className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Work & Multi-Agent Engine</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to orchestrate specialist LOODY agents with DAG execution, approval gates, and persistent milestone tasks.
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

  const toggleAgentSelection = (id: SpecialistAgentId) => {
    setSelectedAgents((prev) =>
      prev.includes(id)
        ? prev.length > 1
          ? prev.filter((x) => x !== id)
          : prev
        : prev.length < 4
        ? [...prev, id]
        : prev
    );
  };

  const handleStartRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    setRunningAgent(true);
    setError(null);
    setNotice(null);
    try {
      const idempotencyKey = `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const res = await api.startAgentRun({
        goal: goal.trim(),
        projectId: agentProjectId || null,
        agents: selectedAgents,
        requireApprovalForWrite: requireApproval,
        idempotencyKey,
      });
      setGoal('');
      setNotice(`Multi-agent DAG run started (${res.run.status}).`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute agent run.');
    } finally {
      setRunningAgent(false);
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    setError(null);
    try {
      await api.createTask({
        title: newTaskTitle.trim(),
        description: newTaskDesc.trim(),
        priority: newTaskPriority,
        subtasks: newTaskSubtasks
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        milestones: ['Implementation Complete'],
      });
      setNewTaskTitle('');
      setNewTaskDesc('');
      setNewTaskSubtasks('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task.');
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Work & Autonomous Agents</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Coordinate 7 specialist LOODY agents via DAG pipelines with explicit write approvals, or track persistent milestone workflows.
          </p>
        </div>

        <div className="flex rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-100 dark:bg-[#0A0E0C] p-1 w-fit">
          {[
            { id: 'agents', label: 'Multi-Agent Orchestrator' },
            { id: 'tasks', label: `Persistent Tasks (${tasks.length})` },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id as typeof tab)}
              className={`rounded-lg px-3.5 py-2 text-xs font-medium min-h-[38px] cursor-pointer ${
                tab === item.id ? 'bg-emerald-600 text-white' : 'text-zinc-600 dark:text-zinc-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs text-emerald-800 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {tab === 'agents' && (
        <div className="space-y-6">
          {/* Specialist Profiles + Launcher */}
          <form onSubmit={handleStartRun} className="rounded-2xl border border-emerald-500/25 bg-white dark:bg-[#0D110F] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Launch Specialist Agent Team</h3>
              <span className="text-[11px] font-mono text-zinc-500">Selected: {selectedAgents.length}/4</span>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {profiles.map((p) => {
                const active = selectedAgents.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggleAgentSelection(p.id)}
                    className={`rounded-xl border p-3 text-start transition-colors cursor-pointer ${
                      active
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display text-xs font-bold text-zinc-900 dark:text-white">{p.name}</span>
                      <Bot className={`w-3.5 h-3.5 ${active ? 'text-emerald-500' : 'text-zinc-400'}`} />
                    </div>
                    <div className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 mt-0.5">{p.roleTitle}</div>
                    <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-2">{p.description}</p>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label htmlFor="agent-goal" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  Execution Objective / Deliverable
                </label>
                <input
                  id="agent-goal"
                  type="text"
                  required
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="e.g. Evaluate API rate limiting strategies and draft a concrete rollout plan"
                  className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white min-h-[42px]"
                />
              </div>
              <div>
                <label htmlFor="agent-project" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  Project Scope (Optional)
                </label>
                <select
                  id="agent-project"
                  value={agentProjectId}
                  onChange={(e) => setAgentProjectId(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[42px]"
                >
                  <option value="">Workspace Global</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={requireApproval}
                  onChange={(e) => setRequireApproval(e.target.checked)}
                  className="rounded border-zinc-300 text-emerald-600"
                />
                <span>Pause synthesis step for explicit human approval before task writeback</span>
              </label>

              <button
                type="submit"
                disabled={runningAgent || !goal.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 min-h-[42px] cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{runningAgent ? 'Executing DAG...' : 'Run Multi-Agent Pipeline'}</span>
              </button>
            </div>
          </form>

          {/* Runs Feed */}
          <div className="space-y-4">
            <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Execution Trace & Run Ledger</h3>
            {runs.length === 0 ? (
              <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-8 text-center text-xs text-zinc-500">
                No agent runs yet. Launch an objective above to execute a multi-agent DAG.
              </div>
            ) : (
              runs.map((run) => (
                <div key={run.id} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-display text-base font-bold text-zinc-900 dark:text-white">{run.goal}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs font-mono text-zinc-500">
                        <span
                          className={`uppercase font-semibold ${
                            run.status === 'completed'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : run.status === 'awaiting_approval'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-zinc-500'
                          }`}
                        >
                          {run.status.replace(/_/g, ' ')}
                        </span>
                        <span>·</span>
                        <span>{run.totalTokens.toLocaleString()} tokens</span>
                        <span>·</span>
                        <span>{run.steps.length} DAG steps</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {['running', 'awaiting_approval', 'queued'].includes(run.status) && (
                        <>
                          <button
                            type="button"
                            onClick={async () => {
                              await api.pauseAgentRun(run.id);
                              await loadAll();
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-amber-500/35 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-300 cursor-pointer"
                          >
                            <Pause className="w-3.5 h-3.5" />
                            <span>Pause Run</span>
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              await api.cancelAgentRun(run.id);
                              await loadAll();
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-600 dark:text-red-300 cursor-pointer"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Cancel Run</span>
                          </button>
                        </>
                      )}
                      {['paused', 'failed'].includes(run.status) && (
                        <button
                          type="button"
                          onClick={async () => {
                            await api.resumeAgentRun(run.id);
                            await loadAll();
                          }}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5" />
                          <span>Resume Run</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Steps Grid */}
                  <div className="grid gap-3 md:grid-cols-2">
                    {run.steps.map((step) => (
                      <div key={step.id} className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3.5 space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-zinc-900 dark:text-white">{step.title}</span>
                          <span className="font-mono text-[11px] uppercase text-emerald-600 dark:text-emerald-400">
                            {step.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        {step.toolIds.length > 0 && (
                          <div className="text-[11px] font-mono text-zinc-500">Tools: {step.toolIds.join(', ')}</div>
                        )}
                        {step.status === 'awaiting_approval' && (
                          <div className="rounded-lg border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-2.5 flex items-center justify-between gap-2">
                            <span className="text-amber-800 dark:text-amber-200">Approve write/task step to continue:</span>
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  await api.approveAgentStep(run.id, step.id, 'approved');
                                  await loadAll();
                                }}
                                className="rounded-lg bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white cursor-pointer"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  await api.approveAgentStep(run.id, step.id, 'rejected');
                                  await loadAll();
                                }}
                                className="rounded-lg border border-red-500/30 px-2.5 py-1 text-[11px] text-red-600 dark:text-red-300 cursor-pointer"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        )}
                        {step.outputText && (
                          <p className="text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap max-h-36 overflow-y-auto leading-relaxed">
                            {step.outputText}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === 'tasks' && (
        <div className="space-y-6">
          {/* Quick Templates */}
          <div className="grid gap-3 md:grid-cols-3">
            {templates.map((tpl) => (
              <div key={tpl.id} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 flex flex-col justify-between gap-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-display text-sm font-bold text-zinc-900 dark:text-white">{tpl.name}</span>
                    <span className="font-mono text-[10px] uppercase text-emerald-500">{tpl.priority}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{tpl.description}</p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await api.createTask({
                      title: tpl.name,
                      description: tpl.description,
                      priority: tpl.priority,
                      templateName: tpl.name,
                      recurringCron: tpl.recurringCron ?? null,
                      subtasks: tpl.subtasks,
                      milestones: tpl.milestones,
                    });
                    await loadAll();
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/35 px-3 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Instantiate Template</span>
                </button>
              </div>
            ))}
          </div>

          {/* Create Custom Task */}
          <form onSubmit={handleCreateTask} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3">
            <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Create Persistent Task</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label htmlFor="task-title" className="block text-xs text-zinc-500 mb-1">Task Title</label>
                <input
                  id="task-title"
                  type="text"
                  required
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="Ship Q2 Security Audit Fixes"
                  className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
                />
              </div>
              <div>
                <label htmlFor="task-priority" className="block text-xs text-zinc-500 mb-1">Priority</label>
                <select
                  id="task-priority"
                  value={newTaskPriority}
                  onChange={(e) => setNewTaskPriority(e.target.value as 'low' | 'medium' | 'high')}
                  className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                type="text"
                aria-label="Task description"
                value={newTaskDesc}
                onChange={(e) => setNewTaskDesc(e.target.value)}
                placeholder="Notes & deliverables"
                className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              />
              <input
                type="text"
                aria-label="Subtasks comma-separated"
                value={newTaskSubtasks}
                onChange={(e) => setNewTaskSubtasks(e.target.value)}
                placeholder="Subtasks (comma-separated, e.g. Write schema, Run tests)"
                className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              />
            </div>
            <button type="submit" className="rounded-xl bg-emerald-600 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[40px] cursor-pointer">
              Save Task
            </button>
          </form>

          {/* Task Cards */}
          <div className="grid gap-4 md:grid-cols-2">
            {tasks.map((task) => (
              <div key={task.id} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="font-display text-base font-bold text-zinc-900 dark:text-white">{task.title}</h4>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-zinc-500">
                      <span className="uppercase text-emerald-500">{task.status}</span>
                      <span>· {task.priority}</span>
                      {task.recurringCron && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {task.recurringCron}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title={task.status === 'paused' ? 'Resume' : 'Pause'}
                      aria-label={`Toggle pause ${task.title}`}
                      onClick={async () => {
                        await api.updateTask(task.id, { status: task.status === 'paused' ? 'active' : 'paused' });
                        await loadAll();
                      }}
                      className="p-1.5 text-zinc-500 hover:text-amber-500 cursor-pointer"
                    >
                      <Pause className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Mark Complete"
                      aria-label={`Complete ${task.title}`}
                      onClick={async () => {
                        await api.updateTask(task.id, { status: task.status === 'completed' ? 'active' : 'completed' });
                        await loadAll();
                      }}
                      className="p-1.5 text-zinc-500 hover:text-emerald-500 cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Duplicate Task"
                      aria-label={`Duplicate ${task.title}`}
                      onClick={async () => {
                        await api.duplicateTask(task.id);
                        await loadAll();
                      }}
                      className="p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    {confirmDeleteTaskId === task.id ? (
                      <span className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={async () => {
                            await api.deleteTask(task.id);
                            setConfirmDeleteTaskId(null);
                            await loadAll();
                          }}
                          className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white cursor-pointer"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteTaskId(null)}
                          className="rounded border border-zinc-300 dark:border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-500 cursor-pointer"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        title="Delete Task"
                        aria-label={`Delete ${task.title}`}
                        onClick={() => setConfirmDeleteTaskId(task.id)}
                        className="p-1.5 text-zinc-500 hover:text-red-500 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {task.description && <p className="text-zinc-600 dark:text-zinc-400">{task.description}</p>}

                {task.subtasks.length > 0 && (
                  <div className="space-y-1 border-t border-zinc-100 dark:border-white/5 pt-2">
                    {task.subtasks.map((st) => (
                      <label key={st.id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={st.completed}
                          onChange={async (e) => {
                            await api.toggleSubtask(task.id, st.id, e.target.checked);
                            await loadAll();
                          }}
                        />
                        <span className={st.completed ? 'line-through text-zinc-400' : 'text-zinc-800 dark:text-zinc-200'}>
                          {st.title}
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                {task.milestones.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {task.milestones.map((ms) => (
                      <button
                        key={ms.id}
                        type="button"
                        onClick={async () => {
                          await api.toggleMilestone(task.id, ms.id, ms.status === 'reached' ? 'pending' : 'reached');
                          await loadAll();
                        }}
                        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] cursor-pointer ${
                          ms.status === 'reached'
                            ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'border-zinc-200 dark:border-white/10 text-zinc-500'
                        }`}
                      >
                        <ShieldCheck className="w-3 h-3" />
                        <span>{ms.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
